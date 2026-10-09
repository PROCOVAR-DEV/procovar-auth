/**
 * Con Redis/Sentinel inalcanzable el limitador NO contesta nunca (ioredis deja el comando en la cola
 * offline), y `/entrega`, `/refresh` y `/token` se quedaban colgadas (humo del 09/10/2026: 4, 8 y 12 s;
 * auditoría A1, MEDIO-1). Aquí el limitador es un doble que no resuelve jamás o que falla, y se mide en
 * RELOJ REAL cuánto tarda la respuesta: menos de 1 s, y con la política de cada ruta:
 *
 *  - `/entrega` y `/token` FALLAN CERRADO: 503 (`comprobacion_no_disponible` / `rate_limit_unavailable`).
 *  - `/refresh` SIGUE («si el limitador no contesta se sigue»), pero ya sin esperar.
 *
 * También: tope de tamaño del refresh (400 `invalid_body`, BAJO-5) y `Cache-Control: no-store` en las
 * respuestas de las tres puertas (INFO).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})

const limitador = vi.hoisted(() => ({ rateLimit: vi.fn() }))
const tokens = vi.hoisted(() => ({ renovar: vi.fn(), emitirEntrega: vi.fn() }))
const betterAuth = vi.hoisted(() => ({ signInEmail: vi.fn() }))
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, session: { findUnique: vi.fn(), deleteMany: vi.fn() } }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/rate-limit', () => limitador)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/apk-tokens', async (original) => ({
    ...(await original<typeof import('@/lib/apk-tokens')>()),
    renovar: tokens.renovar,
    emitirEntrega: tokens.emitirEntrega,
}))

import { POST as entrega } from '../entrega/route'
import { POST as refresh } from '../refresh/route'
import { POST as token } from '../token/route'
import { REDIS_ESPERA_MAX_MS } from '@/lib/con-tope'

const PAR = { token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900, refresh_expires_in: 100 }
const peticion = (body: unknown) =>
    ({ headers: new Headers({ 'user-agent': 'reparto/1.0', 'x-real-ip': '10.1.2.3' }), json: async () => body }) as never

/** Llama y mide en reloj real. */
async function medir(ruta: (r: never) => Promise<Response>, body: unknown) {
    const t0 = Date.now()
    const res = await ruta(peticion(body))
    return { ms: Date.now() - t0, status: res.status, body: await res.json(), res }
}

const colgado = () => limitador.rateLimit.mockImplementation(() => new Promise(() => {})) // no contesta nunca
const fallando = () => limitador.rateLimit.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')))
const bien = () => limitador.rateLimit.mockResolvedValue({ allowed: true, remaining: 5 })

beforeEach(() => {
    vi.clearAllMocks()
    bien()
    tokens.renovar.mockResolvedValue({ ok: true, par: PAR })
    tokens.emitirEntrega.mockResolvedValue({ ok: true, token: 't', expires_in: 600, ambito: 'reparto.entrega' })
})

describe('el tope existe y es menor de 1 s', () => {
  it('REDIS_ESPERA_MAX_MS < 1000', () => expect(REDIS_ESPERA_MAX_MS).toBeLessThan(1000))
})

describe.each([
    ['colgado (no contesta nunca)', colgado],
    ['fallando', fallando],
])('limitador %s', (_nombre, ponerLimitador) => {
    beforeEach(() => {
        ponerLimitador()
    })

    it('/entrega: 503 comprobacion_no_disponible en menos de 1 s, sin emitir nada', async () => {
        const r = await medir(entrega, { refresh_token: 'x'.repeat(43) })
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(r.ms).toBeLessThan(1000)
        expect(tokens.emitirEntrega).not.toHaveBeenCalled()
    })

    it('/token: 503 rate_limit_unavailable en menos de 1 s, sin tocar la contraseña', async () => {
        const r = await medir(token, { email: 'a@b.c', password: 'x' })
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'rate_limit_unavailable' })
        expect(r.ms).toBeLessThan(1000)
        expect(betterAuth.signInEmail).not.toHaveBeenCalled()
    })

    it('/refresh: SIGUE (renueva) en menos de 1 s', async () => {
        const r = await medir(refresh, { refresh_token: 'x'.repeat(43) })
        expect(r.status).toBe(200)
        expect(r.body).toEqual(PAR)
        expect(r.ms).toBeLessThan(1000)
        expect(tokens.renovar).toHaveBeenCalledTimes(1)
    })
})

describe('con un limitador lento pero que contesta dentro del tope, nada cambia', () => {
    it('/entrega: contesta a los 200 ms y emite', async () => {
        limitador.rateLimit.mockImplementation(() => new Promise((ok) => setTimeout(() => ok({ allowed: true, remaining: 1 }), 200)))
        const r = await medir(entrega, { refresh_token: 'x'.repeat(43) })
        expect(r.status).toBe(200)
        expect(tokens.emitirEntrega).toHaveBeenCalledTimes(1)
    })

    it('/refresh y /entrega: un 429 sigue siendo un 429', async () => {
        limitador.rateLimit.mockResolvedValue({ allowed: false, remaining: 0 })
        expect((await medir(refresh, { refresh_token: 'x'.repeat(43) })).status).toBe(429)
        expect((await medir(entrega, { refresh_token: 'x'.repeat(43) })).status).toBe(429)
    })
})

describe('el refresh tiene tope de tamaño (BAJO-5)', () => {
    const justo = 'x'.repeat(256)
    const largo = 'x'.repeat(257)

    for (const [nombre, ruta] of [['/entrega', entrega], ['/refresh', refresh]] as const) {
        for (const campo of ['refresh_token', 'refresh']) {
            it(`${nombre}: ${campo} de 8 MB, o de 257 caracteres, es 400 invalid_body y no llega ni al limitador`, async () => {
                for (const enorme of ['x'.repeat(8 * 1024 * 1024), largo]) {
                    const r = await medir(ruta, { [campo]: enorme })
                    expect(r.status).toBe(400)
                    expect(r.body).toEqual({ error: 'invalid_body' })
                }
                expect(limitador.rateLimit).not.toHaveBeenCalled()
            })

            it(`${nombre}: ${campo} de 256 caracteres (el tope) todavía pasa`, async () => {
                expect((await medir(ruta, { [campo]: justo })).status).toBe(200)
            })
        }
    }
})

describe('Cache-Control: no-store en las respuestas de las puertas (INFO)', () => {
    it('/entrega con token', async () => {
        const r = await medir(entrega, { refresh_token: 'x'.repeat(43) })
        expect(r.status).toBe(200)
        expect(r.res.headers.get('cache-control')).toBe('no-store')
    })

    it('/refresh con par', async () => {
        const r = await medir(refresh, { refresh_token: 'x'.repeat(43) })
        expect(r.status).toBe(200)
        expect(r.res.headers.get('cache-control')).toBe('no-store')
    })

    it('/token (aquí un 503 y un 400: lo llevan las respuestas de error también)', async () => {
        fallando()
        expect((await medir(token, { email: 'a@b.c', password: 'x' })).res.headers.get('cache-control')).toBe('no-store')
        expect((await medir(token, {})).res.headers.get('cache-control')).toBe('no-store')
    })

    it('y también con Origin permitido (el atajo de CORS no se lo salta)', async () => {
        const res = await entrega({
            headers: new Headers({ origin: 'https://reparto.procovar.cloud', 'x-real-ip': '10.1.2.3' }),
            json: async () => ({ refresh_token: 'x'.repeat(43) }),
        } as never)
        expect(res.headers.get('access-control-allow-origin')).toBe('https://reparto.procovar.cloud')
        expect(res.headers.get('cache-control')).toBe('no-store')
    })
})
