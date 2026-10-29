/**
 * POST /api/dispositivos/estado: el aparato cuenta cómo le va. Se ata que solo el DUEÑO del aparato escribe su fila (la persona y la
 * aplicación salen del token), que un token que no es de acceso no vale, que lo que llega se limpia, y que el limitador y la base
 * no convierten esto en un fallo de la aplicación.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SignJWT } from 'jose'

process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
process.env.APP_URL = 'https://auth.example.com'

const db = vi.hoisted(() => ({ dispositivo: { findUnique: vi.fn(), update: vi.fn() } }))
const limitador = vi.hoisted(() => ({ rateLimit: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/rate-limit', () => limitador)
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../route'
import { firmarAcceso } from '@/lib/apk-tokens'

const ID = '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10'
const IDENTIDAD = {
    sub: 'u1', email: 'm@x', name: 'Maikel', username: 'maikel', role: 'LOGISTICO', roles: ['LOGISTICO'], sucursal: 'STG',
    sucursales: ['STG'], entradas: ['delivery.entrar'], codigoVendedor: null, supervisorId: null,
}

async function llamar(cuerpo: unknown, cabeceras: Record<string, string> = {}, bearer?: string) {
    const token = bearer ?? (await firmarAcceso(IDENTIDAD, 's1', Date.now(), 'delivery-apk'))
    const req = {
        headers: new Headers({ authorization: `Bearer ${token}`, 'x-aparato-id': ID, ...cabeceras }),
        text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    } as never
    const res = await POST(req)
    return { status: res.status, body: await res.json() }
}

beforeEach(() => {
    vi.resetAllMocks()
    limitador.rateLimit.mockResolvedValue({ allowed: true, remaining: 0 })
    db.dispositivo.findUnique.mockResolvedValue({ id: 'd1', bloqueadoAt: null, personas: [{ id: 'dp1' }] })
    db.dispositivo.update.mockResolvedValue({})
})

describe('quién puede contar el estado de un aparato', () => {
    it('el dueño: se anota en SU fila (aplicación y persona del token)', async () => {
        const r = await llamar({ pendientes: 3, rechazados: 0, ultimaSubida: '2026-10-29T14:00:00Z', ultimoError: ' falló\nla subida ' })
        expect(r).toEqual({ status: 200, body: { ok: true, revocado: false } })
        expect(db.dispositivo.findUnique.mock.calls[0][0].where).toEqual({ clientId_aparatoId: { clientId: 'delivery-apk', aparatoId: ID } })
        expect(db.dispositivo.findUnique.mock.calls[0][0].select.personas.where).toEqual({ userId: 'u1' })
        const data = db.dispositivo.update.mock.calls[0][0].data
        expect(data).toMatchObject({ pendientes: 3, rechazados: 0, ultimoError: 'falló la subida' })
        expect(data.estadoAt).toBeInstanceOf(Date)
    })

    it('OTRA persona con un token válido NO escribe en un aparato donde nunca ha entrado (la búsqueda va con SU cuenta)', async () => {
        db.dispositivo.findUnique.mockResolvedValue({ id: 'd1', bloqueadoAt: null, personas: [] })
        expect((await llamar({ pendientes: 99 })).status).toBe(404)
        expect(db.dispositivo.update).not.toHaveBeenCalled()
    })

    it('un aparato que no está registrado es 404 (se registra al renovar)', async () => {
        db.dispositivo.findUnique.mockResolvedValue(null)
        expect((await llamar({})).status).toBe(404)
    })

    it('sin token, con basura o con un token que NO es de acceso: 401', async () => {
        const req = (auth?: string) => ({ headers: new Headers({ ...(auth ? { authorization: auth } : {}), 'x-aparato-id': ID }), text: async () => '{}' }) as never
        expect((await POST(req())).status).toBe(401)
        expect((await POST(req('Bearer basura'))).status).toBe(401)
        const ajeno = await new SignJWT({ sub: 'u1', azp: 'delivery-apk', purpose: 'otro-proposito' })
            .setProtectedHeader({ alg: 'HS256' }).setIssuer('qb-auth').setExpirationTime('5m')
            .sign(new TextEncoder().encode(process.env.JWT_SECRET!))
        expect((await POST(req(`Bearer ${ajeno}`))).status).toBe(401)
        expect(db.dispositivo.update).not.toHaveBeenCalled()
    })
})

describe('lo que llega', () => {
    it('sin X-Aparato-Id válido, 400', async () => {
        expect((await llamar({}, { 'x-aparato-id': 'no-es-uuid' })).status).toBe(400)
    })
    it('un cuerpo que no es JSON, o enorme, es 400; uno vacío vale (solo «sigo vivo»)', async () => {
        expect((await llamar('no es json')).status).toBe(400)
        expect((await llamar('x'.repeat(5000))).status).toBe(400)
        expect((await llamar('')).status).toBe(200)
    })
    it('lo absurdo se descarta campo a campo, no rompe nada', async () => {
        await llamar({ pendientes: -5, rechazados: 'muchos', ultimaSubida: '2001-01-01T00:00:00Z' })
        const data = db.dispositivo.update.mock.calls[0][0].data
        expect(data).not.toHaveProperty('pendientes')
        expect(data).not.toHaveProperty('rechazados')
        expect(data).not.toHaveProperty('ultimaSubida')
    })
})

describe('el bloqueo y los límites', () => {
    it('un aparato bloqueado se entera: `revocado: true`', async () => {
        db.dispositivo.findUnique.mockResolvedValue({ id: 'd1', bloqueadoAt: new Date(), personas: [{ id: 'dp1' }] })
        expect((await llamar({})).body).toEqual({ ok: true, revocado: true })
    })
    it('más de una por minuto: 200 `ignorado`, sin anotar nada', async () => {
        limitador.rateLimit.mockResolvedValue({ allowed: false, remaining: 0 })
        expect(await llamar({ pendientes: 1 })).toEqual({ status: 200, body: { ok: true, ignorado: true } })
        expect(db.dispositivo.update).not.toHaveBeenCalled()
    })
    it('si el limitador no contesta, se SIGUE', async () => {
        limitador.rateLimit.mockRejectedValue(new Error('redis caído'))
        expect((await llamar({})).status).toBe(200)
    })
    it('si la base falla: 503 (la aplicación lo trata como «ahora no»), nunca 500', async () => {
        db.dispositivo.update.mockRejectedValue(new Error('base caída'))
        expect((await llamar({})).status).toBe(503)
    })
})
