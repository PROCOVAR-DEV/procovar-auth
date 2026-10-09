/**
 * Redis Sentinel client (singleton).
 *
 * DB layout (configured via env):
 *  - REDIS_DB_DEFAULT  (4): generic fallbacks
 *  - REDIS_DB_LOCKS    (5): rate-limit, distributed locks, anti-replay nonces
 *  - REDIS_DB_SESSIONS (6): callback tokens, auth codes, session bindings
 *  - REDIS_DB_CACHE    (7): read-through caches
 *
 * Keys are auto-prefixed with REDIS_PREFIX (e.g. "qb-accounts:").
 */
import Redis, { type RedisOptions, type SentinelAddress } from 'ioredis';
import { logger } from './logger';

function parseSentinels(raw: string | undefined): SentinelAddress[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
            const [host, port] = entry.split(':');
            return { host, port: Number(port || 26379) };
        });
}

const SENTINELS = parseSentinels(process.env.REDIS_SENTINELS);
const NAME = process.env.REDIS_MASTER_NAME || 'master';
const PASSWORD = process.env.REDIS_PASSWORD || undefined;
const PREFIX = process.env.REDIS_PREFIX || '';

const DB = {
    default: Number(process.env.REDIS_DB_DEFAULT ?? 4),
    locks: Number(process.env.REDIS_DB_LOCKS ?? 5),
    sessions: Number(process.env.REDIS_DB_SESSIONS ?? 6),
    cache: Number(process.env.REDIS_DB_CACHE ?? 7),
} as const;

export type RedisScope = keyof typeof DB;

/**
 * Lo más que UN comando del cliente `locks` espera respuesta. Ese cliente sólo sirve al limitador
 * de las puertas de la APK y al anti-replay del nonce (un `EVAL` y un `SET NX`, de milisegundos).
 * Sin tope, con los centinelas inalcanzables el comando no rechazaba NUNCA (se quedaba en la cola
 * offline) y `/entrega`, `/refresh` y `/token` se colgaban. Los demás clientes no lo llevan: el de
 * `sessions` duplica a uno de suscripción, que no debe caducar. Las puertas esperan menos todavía
 * (`conTope`, 800 ms): esto es la red de seguridad para lo que no pase por ella.
 */
export const COMANDO_LOCKS_MAX_MS = 1500;

function buildOptions(db: number, commandTimeout?: number): RedisOptions {
    return {
        sentinels: SENTINELS,
        name: NAME,
        password: PASSWORD,
        sentinelPassword: PASSWORD,
        db,
        keyPrefix: PREFIX,
        enableAutoPipelining: true,
        maxRetriesPerRequest: 3,
        commandTimeout,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 200, 2000),
        reconnectOnError: (err) => {
            const target = ['READONLY', 'ETIMEDOUT'];
            return target.some((t) => err.message.includes(t));
        },
    };
}

const clients: Partial<Record<RedisScope, Redis>> = {};

declare global {
    var __qbRedisClients: Partial<Record<RedisScope, Redis>> | undefined;
}

const store = globalThis.__qbRedisClients ?? (globalThis.__qbRedisClients = clients);

export function getRedis(scope: RedisScope = 'sessions'): Redis {
    if (SENTINELS.length === 0) {
        throw new Error(
            'Redis not configured. Set REDIS_SENTINELS, REDIS_MASTER_NAME, REDIS_PASSWORD.'
        );
    }
    if (!store[scope]) {
        const client = new Redis(buildOptions(DB[scope], scope === 'locks' ? COMANDO_LOCKS_MAX_MS : undefined));
        client.on('error', (err) => {
            logger.warn(`[redis:${scope}] error`, { msg: err.message });
        });
        client.on('connect', () => {
            logger.info(`[redis:${scope}] connected`, { db: DB[scope] });
        });
        store[scope] = client;
    }
    return store[scope]!;
}

export async function pingRedis(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
        const r = await getRedis('default').ping();
        return { ok: r === 'PONG', latencyMs: Date.now() - t0 };
    } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
    }
}
