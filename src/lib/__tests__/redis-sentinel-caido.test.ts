/**
 * Con los centinelas inalcanzables, el cliente REAL de ioredis (sin dobles de Redis) deja el comando en la
 * cola offline y no rechaza nunca: así se colgaban `/entrega`, `/refresh` y `/token` (auditoría A1,
 * MEDIO-1; humo: 4, 8 y 12 s). `commandTimeout` (SÓLO en el cliente `locks`) lo acota, y las puertas
 * esperan además `conTope` (800 ms). El puerto 1 de localhost rechaza la conexión al instante.
 */
import { describe, it, expect, vi, afterAll } from 'vitest'

vi.hoisted(() => {
    process.env.REDIS_SENTINELS = '127.0.0.1:1'
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

import { COMANDO_LOCKS_MAX_MS, getRedis } from '../redis'
import { rateLimit } from '../rate-limit'
import { POST as entrega } from '@/app/api/auth/entrega/route'

const SIN_RESPUESTA = 'COLGADO: el comando no rechazó en 4 s'
const conReserva = <T>(p: Promise<T>) =>
    Promise.race([p.then(() => 'respondió', (e: Error) => e.message), new Promise<string>((ok) => setTimeout(() => ok(SIN_RESPUESTA), 4000))])

afterAll(() => {
    getRedis('locks').disconnect()
    getRedis('sessions').disconnect()
})

describe('commandTimeout', () => {
    it('sólo el cliente `locks` lo lleva (el de `sessions` duplica a uno de suscripción: no debe caducar)', () => {
        expect(getRedis('locks').options.commandTimeout).toBe(COMANDO_LOCKS_MAX_MS)
        expect(COMANDO_LOCKS_MAX_MS).toBeGreaterThanOrEqual(1000)
        expect(COMANDO_LOCKS_MAX_MS).toBeLessThanOrEqual(2000)
        for (const otro of ['sessions', 'default', 'cache'] as const) expect(getRedis(otro).options.commandTimeout, otro).toBeUndefined()
        getRedis('default').disconnect()
        getRedis('cache').disconnect()
    })

    it('rateLimit REAL con los centinelas caídos rechaza ("Command timed out") en lugar de colgarse', async () => {
        const t0 = Date.now()
        const salida = await conReserva(rateLimit({ scope: 's', identifier: 'i', capacity: 1, refillPerSec: 1 }))
        expect(salida).toBe('Command timed out')
        expect(Date.now() - t0).toBeGreaterThanOrEqual(COMANDO_LOCKS_MAX_MS - 100)
        expect(Date.now() - t0).toBeLessThan(COMANDO_LOCKS_MAX_MS + 1000)
    })
})

describe('la puerta, de punta a punta con el cliente real y los centinelas caídos', () => {
    it('/entrega: 503 comprobacion_no_disponible en menos de 1 s (antes ~4 s o colgada)', async () => {
        const t0 = Date.now()
        const res = await entrega({
            headers: new Headers({ 'x-real-ip': '10.9.9.9' }),
            json: async () => ({ refresh_token: 'x'.repeat(43) }),
        } as never)
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: 'comprobacion_no_disponible' })
        expect(Date.now() - t0).toBeLessThan(1000)
    })
})
