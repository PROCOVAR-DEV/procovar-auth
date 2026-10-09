/**
 * Con Redis caído, la firma de servicio a servicio falla CERRADA y RÁPIDO.
 *
 * El anti-replay del nonce necesita Redis. Antes, con Redis apagado, `POST /api/auth/verify-session`
 * daba 500 `internal_error` tras ~4,4 s (el cliente compartido reintenta hasta rendirse). Ahora:
 * 503 `service_unavailable` en menos de ~1 s, sin dejar pasar la petición y sin tragarse el error.
 * Un nonce repetido sigue siendo 401 `replay` (eso NO cambia).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const redis = vi.hoisted(() => ({ set: vi.fn(), getRedis: vi.fn() }))
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
const cliente = vi.hoisted(() => ({ loadActiveClient: vi.fn() }))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))
const db = vi.hoisted(() => ({ session: { findUnique: vi.fn() }, member: { findMany: vi.fn() }, user: { findUnique: vi.fn() } }))

vi.mock('@/lib/redis', () => ({ getRedis: redis.getRedis }))
vi.mock('@/lib/logger', () => ({ logger }))
vi.mock('@/lib/callback-validator', () => ({ loadActiveClient: cliente.loadActiveClient }))
vi.mock('@/lib/jwks', () => ({ verifyRs256: vi.fn() }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/rbac/resolve-permissions', () => ({ resolveRbac: vi.fn(async () => ({ global: [] })) }))

import { ServiceAuthError, signRequest, deriveSigningKey, verifyRequest, NONCE_ESPERA_MAX_MS } from '../service-auth'
import { POST as verifySession } from '@/app/api/auth/verify-session/route'

const CLIENTE = 'app-de-prueba'
const RUTA = '/api/auth/verify-session'
const CUERPO = JSON.stringify({ sessionToken: 'x'.repeat(20) })

/** Una petición firmada de verdad (misma firma que verifica el servidor). */
const firmada = (nonce = 'nonce-' + Math.random().toString(16).slice(2)) => {
    const headers = signRequest({
        method: 'POST', path: RUTA, body: CUERPO, clientId: CLIENTE, signingKey: deriveSigningKey(CLIENTE), nonce,
    })
    return { method: 'POST', path: RUTA, body: CUERPO, headers: headers as unknown as Record<string, string> }
}
const peticionHttp = () =>
    new Request('http://accesos.test' + RUTA, { method: 'POST', body: CUERPO, headers: firmada().headers }) as never

const colgado = () => redis.set.mockImplementation(() => new Promise(() => {})) // no contesta nunca
const fallando = (msg = 'ECONNREFUSED') => redis.set.mockImplementation(() => Promise.reject(new Error(msg)))

beforeEach(() => {
    vi.clearAllMocks()
    process.env.SERVICE_AUTH_SECRET = 's'.repeat(40)
    redis.getRedis.mockReturnValue({ set: redis.set })
    redis.set.mockResolvedValue('OK')
    cliente.loadActiveClient.mockResolvedValue({ scopes: ['session:verify'], name: 'App' })
})
afterEach(() => vi.useRealTimers())

describe('verifyRequest con Redis caído', () => {
    it('Redis CUELGA: 503 service_unavailable a los NONCE_ESPERA_MAX_MS, ni antes ni después', async () => {
        vi.useFakeTimers()
        colgado()
        let resultado: unknown = 'pendiente'
        void verifyRequest(firmada()).then((v) => (resultado = v), (e) => (resultado = e))
        await vi.advanceTimersByTimeAsync(NONCE_ESPERA_MAX_MS - 1)
        expect(resultado).toBe('pendiente')
        await vi.advanceTimersByTimeAsync(1)
        expect(resultado).toBeInstanceOf(ServiceAuthError)
        expect(resultado).toMatchObject({ code: 'service_unavailable', status: 503 })
    })

    it('el límite es menor de ~1 s (reloj real, Redis colgado)', async () => {
        colgado()
        const t0 = Date.now()
        await expect(verifyRequest(firmada())).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
        expect(Date.now() - t0).toBeLessThan(1000)
        expect(NONCE_ESPERA_MAX_MS).toBeLessThan(1000)
    })

    it('Redis FALLA: 503 al instante, y el error NO se traga (queda en el log con el motivo)', async () => {
        fallando('ECONNREFUSED 10.0.0.9:6379')
        await expect(verifyRequest(firmada())).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('anti-replay'),
            expect.objectContaining({ clientId: CLIENTE, error: 'ECONNREFUSED 10.0.0.9:6379' }),
        )
    })

    it('Redis sin configurar (getRedis lanza): también 503, nunca deja pasar', async () => {
        redis.getRedis.mockImplementation(() => { throw new Error('Redis not configured') })
        await expect(verifyRequest(firmada())).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
    })

    it('un nonce repetido sigue siendo 401 replay (no se confunde con Redis caído)', async () => {
        redis.set.mockResolvedValue(null) // SET NX no escribió: ya existía
        await expect(verifyRequest(firmada())).rejects.toMatchObject({ code: 'replay', status: 401 })
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('con Redis sano pasa, y el SET NX lleva el nonce y el TTL', async () => {
        const pet = firmada('nonce-fijo')
        await expect(verifyRequest(pet)).resolves.toEqual({ clientId: CLIENTE, keyVersion: 1 })
        expect(redis.set).toHaveBeenCalledWith(`svc:nonce:${CLIENTE}:nonce-fijo`, '1', 'EX', 300, 'NX')
    })

    it('una firma mala se rechaza ANTES de tocar Redis', async () => {
        const pet = firmada()
        pet.headers['x-signature'] = '0'.repeat(64)
        await expect(verifyRequest(pet)).rejects.toMatchObject({ code: 'bad_signature' })
        expect(redis.getRedis).not.toHaveBeenCalled()
    })
})

describe('POST /api/auth/verify-session con Redis caído (de punta a punta, con la firma real)', () => {
    it('Redis cuelga: 503 { error: service_unavailable } en <1 s y la sesión NO se consulta', async () => {
        colgado()
        const t0 = Date.now()
        const res = (await verifySession(peticionHttp())) as Response
        expect(Date.now() - t0).toBeLessThan(1000)
        expect(res.status).toBe(503)
        expect((await res.json()).error).toBe('service_unavailable')
        expect(betterAuth.getSession).not.toHaveBeenCalled() // fallo cerrado: no pasó al manejador
    })

    it('Redis falla: 503 service_unavailable (antes era 500 internal_error)', async () => {
        fallando()
        const res = (await verifySession(peticionHttp())) as Response
        expect(res.status).toBe(503)
        expect((await res.json()).error).toBe('service_unavailable')
        expect(betterAuth.getSession).not.toHaveBeenCalled()
    })

    it('Redis sano: la petición llega al manejador', async () => {
        betterAuth.getSession.mockResolvedValue(null)
        const res = (await verifySession(peticionHttp())) as Response
        expect(res.status).toBe(401) // invalid_session: llegó hasta la sesión
        expect((await res.json()).error).toBe('invalid_session')
        expect(betterAuth.getSession).toHaveBeenCalled()
    })
})
