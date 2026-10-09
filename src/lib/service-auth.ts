/**
 * Service-to-Service authentication via HMAC-SHA256 signed requests.
 *
 * Signature algorithm:
 *   stringToSign = `${method}\n${path}\n${ts}\n${nonce}\n${sha256(body)}`
 *   signature    = hex(HMAC_SHA256(clientSecret, stringToSign))
 *
 * Required request headers:
 *   X-Client-Id   : ClientApp.clientId
 *   X-Timestamp   : unix seconds (rejected if |now - ts| > MAX_SKEW)
 *   X-Nonce       : random uuid (rejected on replay via Redis SETNX, TTL = MAX_SKEW)
 *   X-Signature   : hex digest
 *
 * The `path` MUST be the full request path including the query string,
 * exactly as received by the server.
 *
 * The clientSecret is held only by the consuming microservice; qb-auth stores
 * an argon2id hash. To verify, the secret must be passed in (typically via the
 * legacy `BEARER_TOKEN` shared secret while we bootstrap, OR — preferred —
 * we derive a per-client signing key from a SERVICE_AUTH_SECRET HMAC of clientId,
 * so qb-auth never has to store the plaintext secret).
 *
 * We use the derived-key approach for robustness:
 *   signingKey = HMAC_SHA256(SERVICE_AUTH_SECRET, "svc:" + clientId)
 * The microservice receives this `signingKey` exactly once when registered.
 * Rotating SERVICE_AUTH_SECRET rotates ALL service keys (use rare).
 * Rotating a single client uses ClientApp.signingKeyVersion (kid) — see
 * deriveSigningKey().
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getRedis } from './redis';
import { logger } from './logger';
import { REDIS_ESPERA_MAX_MS, conTope } from './con-tope';

const MAX_SKEW_SECONDS = Number(process.env.SERVICE_AUTH_MAX_SKEW ?? 300);
const NONCE_KEY = (clientId: string, nonce: string) => `svc:nonce:${clientId}:${nonce}`;

/**
 * Lo más que la comprobación anti-replay espera a Redis (`conTope`). El cliente compartido reintenta ~4 s
 * antes de rendirse (sirve a los demás usos), y una petición de servicio no puede esperar tanto:
 * pasado este tiempo se rechaza con 503. NO cambia el tiempo de espera de los otros usos de Redis.
 */
export const NONCE_ESPERA_MAX_MS = REDIS_ESPERA_MAX_MS;

/**
 * Reserva el nonce (SET NX). `true` = nuevo, `false` = ya usado (replay).
 * Sin Redis NO se puede saber si es un replay: falla CERRADO (503 `service_unavailable`, que el
 * llamante puede reintentar) en vez de dejar pasar la petición o dar un 500 tras 4 s.
 */
async function reservarNonce(clientId: string, nonce: string): Promise<boolean> {
    try {
        const orden = getRedis('locks').set(NONCE_KEY(clientId, nonce), '1', 'EX', MAX_SKEW_SECONDS, 'NX');
        return (await conTope(orden, NONCE_ESPERA_MAX_MS)) === 'OK';
    } catch (e) {
        logger.error('[service-auth] Redis no responde: anti-replay no disponible, se rechaza', {
            clientId,
            error: (e as Error).message,
        });
        throw new ServiceAuthError('service_unavailable', 'Anti-replay store unavailable', 503);
    }
}

export class ServiceAuthError extends Error {
    constructor(public code: string, message: string, public status = 401) {
        super(message);
    }
}

function getServiceSecret(): Buffer {
    const s = process.env.SERVICE_AUTH_SECRET;
    if (!s || s.length < 32) {
        throw new ServiceAuthError('config', 'SERVICE_AUTH_SECRET is not set or too short', 500);
    }
    return Buffer.from(s, 'utf8');
}

/**
 * Derive the per-client signing key. `version` allows per-client rotation
 * without touching SERVICE_AUTH_SECRET.
 */
export function deriveSigningKey(clientId: string, version = 1): string {
    return createHmac('sha256', getServiceSecret())
        .update(`svc:v${version}:${clientId}`)
        .digest('hex');
}

function sha256Hex(input: string | Buffer): string {
    return createHash('sha256').update(input).digest('hex');
}

export interface SignedHeaders {
    'x-client-id': string;
    'x-timestamp': string;
    'x-nonce': string;
    'x-signature': string;
    'x-key-version'?: string;
}

export interface SignInput {
    method: string;
    /** Full path INCLUDING query string. */
    path: string;
    body?: string | Buffer | null;
    clientId: string;
    signingKey: string;
    keyVersion?: number;
    nonce?: string;
    timestamp?: number;
}

export function signRequest(input: SignInput): SignedHeaders {
    const ts = String(input.timestamp ?? Math.floor(Date.now() / 1000));
    const nonce = input.nonce ?? cryptoRandomNonce();
    const bodyHash = sha256Hex(input.body ?? '');
    const stringToSign = [input.method.toUpperCase(), input.path, ts, nonce, bodyHash].join('\n');
    const sig = createHmac('sha256', Buffer.from(input.signingKey, 'hex'))
        .update(stringToSign)
        .digest('hex');
    const headers: SignedHeaders = {
        'x-client-id': input.clientId,
        'x-timestamp': ts,
        'x-nonce': nonce,
        'x-signature': sig,
    };
    if (input.keyVersion && input.keyVersion !== 1) {
        headers['x-key-version'] = String(input.keyVersion);
    }
    return headers;
}

function cryptoRandomNonce(): string {
    // 16 random bytes hex (128 bits) is plenty for a 5-min window
    return createHash('sha1')
        .update(`${Date.now()}-${Math.random()}-${process.pid}-${Math.random()}`)
        .digest('hex')
        .slice(0, 32);
}

export interface VerifiedService {
    clientId: string;
    keyVersion: number;
}

export interface VerifyInput {
    method: string;
    path: string;
    body: string | Buffer;
    headers: Headers | Record<string, string | undefined>;
}

function getHeader(h: VerifyInput['headers'], name: string): string | undefined {
    if (h instanceof Headers) return h.get(name) ?? undefined;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(h)) {
        if (k.toLowerCase() === lower) return v;
    }
    return undefined;
}

export async function verifyRequest(input: VerifyInput): Promise<VerifiedService> {
    const clientId = getHeader(input.headers, 'x-client-id');
    const ts = getHeader(input.headers, 'x-timestamp');
    const nonce = getHeader(input.headers, 'x-nonce');
    const sig = getHeader(input.headers, 'x-signature');
    const keyVersionRaw = getHeader(input.headers, 'x-key-version');

    if (!clientId || !ts || !nonce || !sig) {
        throw new ServiceAuthError('missing_headers', 'Missing service-auth headers');
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
        throw new ServiceAuthError('invalid_timestamp', 'Invalid X-Timestamp');
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > MAX_SKEW_SECONDS) {
        throw new ServiceAuthError('clock_skew', `Timestamp skew ${skew}s exceeds ${MAX_SKEW_SECONDS}s`);
    }

    const keyVersion = keyVersionRaw ? Number(keyVersionRaw) : 1;
    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
        throw new ServiceAuthError('invalid_key_version', 'Invalid X-Key-Version');
    }

    const signingKey = deriveSigningKey(clientId, keyVersion);
    const bodyHash = sha256Hex(input.body ?? '');
    const stringToSign = [input.method.toUpperCase(), input.path, ts, nonce, bodyHash].join('\n');
    const expected = createHmac('sha256', Buffer.from(signingKey, 'hex'))
        .update(stringToSign)
        .digest();
    const provided = Buffer.from(sig, 'hex');

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        logger.warn('[service-auth] bad signature', { clientId });
        throw new ServiceAuthError('bad_signature', 'Signature verification failed');
    }

    // Anti-replay: nonce must be unique per client within the skew window.
    if (!(await reservarNonce(clientId, nonce))) {
        throw new ServiceAuthError('replay', 'Nonce already used');
    }

    return { clientId, keyVersion };
}
