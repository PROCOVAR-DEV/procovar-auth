/**
 * EL REGISTRO DE DISPOSITIVOS EN LAS PUERTAS (docs/dispositivos.md, 29/10/2026).
 *
 * `/api/auth/refresh` y `/api/auth/token` reconocen `X-Aparato-Id` (UUID v7) y anotan el aparato. Lo que se ata:
 * que anota con la persona, la aplicación y la sucursal DEL TOKEN (no de lo que diga el cliente), que sin cabecera o con
 * una mala no hace nada, que NADA de esto puede romper la renovación (una caída de la tabla no es un 401 ni un 500), y
 * que un aparato bloqueado por un administrador recibe el 401 de siempre ANTES de gastar el refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
process.env.APP_URL = 'https://auth.example.com'

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    session: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    dispositivo: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
    dispositivoApp: { upsert: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    dispositivoPersona: { upsert: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ signInEmail: vi.fn() }))
const limitador = vi.hoisted(() => ({ rateLimit: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/rate-limit', () => limitador)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST as token } from '../token/route'
import { POST as refresh } from '../refresh/route'

const ID = '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10'

type Ruta = (req: never) => Promise<Response>
function peticion(body: unknown, cabeceras: Record<string, string> = {}) {
    return { headers: new Headers({ 'user-agent': 'ProcovarReparto/1.0.47 (Windows)', ...cabeceras }), json: async () => body } as never
}
async function llamar(ruta: Ruta, body: unknown, cabeceras?: Record<string, string>) {
    const res = await ruta(peticion(body, cabeceras))
    return { status: res.status, body: await res.json() }
}

const PERSONA = {
    id: 'u1', name: 'Maikel', email: 'maikel@procovar.local', username: 'maikel', activo: true, isSystemAdmin: false,
    defaultRole: { name: 'LOGISTICO', permissions: [{ permission: { key: 'delivery.entrar' } }] },
    members: [{ organization: { codigo: 'STG', activa: true }, memberRoles: [{ role: { name: 'LOGISTICO' } }] }],
}
const FILA_DE_REFRESH = {
    id: 'rt1', userId: 'u1', sessionId: 's1', familyId: 'fam1',
    expiresAt: new Date(Date.now() + 60_000), usedAt: null, revokedAt: null,
}

beforeEach(() => {
    vi.resetAllMocks()
    limitador.rateLimit.mockResolvedValue({ allowed: true, remaining: 10 })
    betterAuth.signInEmail.mockResolvedValue({ token: 'tok-de-sesion' })
    db.session.findUnique.mockResolvedValue({ id: 's1', userId: 'u1', revokedAt: null })
    db.session.updateMany.mockResolvedValue({ count: 1 })
    db.session.deleteMany.mockResolvedValue({ count: 1 })
    db.user.findUnique.mockResolvedValue(PERSONA)
    db.refreshToken.create.mockResolvedValue({ id: 'rt-nuevo' })
    db.refreshToken.updateMany.mockResolvedValue({ count: 1 })
    db.refreshToken.update.mockResolvedValue({})
    db.refreshToken.findUnique.mockResolvedValue(FILA_DE_REFRESH)
    db.dispositivo.create.mockResolvedValue({ id: 'd1' })
    db.dispositivo.update.mockResolvedValue({ id: 'd1', huella: null })
    db.dispositivo.findUnique.mockResolvedValue(null)
    db.dispositivoApp.findUnique.mockResolvedValue(null)
    db.dispositivoApp.upsert.mockResolvedValue({ id: 'da1' })
    db.dispositivoPersona.upsert.mockResolvedValue({})
    db.dispositivoApp.findFirst.mockResolvedValue(null)
})

describe('POST /api/auth/refresh con X-Aparato-Id', () => {
    it('anota el aparato con la persona, la aplicación y la sucursal del TOKEN y la versión del User-Agent', async () => {
        const r = await llamar(refresh, { refresh_token: 'el-que-tengo' }, { 'x-aparato-id': ID, 'x-aparato-nombre': 'PC de Maikel' })

        expect(r.status).toBe(200)
        expect(db.dispositivo.create).toHaveBeenCalledTimes(1)
        expect(db.dispositivo.create.mock.calls[0][0].data).toMatchObject({ plataforma: 'Windows', equipo: 'PC de Maikel' })
        const app = db.dispositivoApp.upsert.mock.calls[0][0]
        expect(app.where).toEqual({ clientId_aparatoId: { clientId: 'delivery-apk', aparatoId: ID } })
        expect(app.update).toMatchObject({ userId: 'u1', sucursal: 'STG', version: '1.0.47', familyId: 'fam1' })
        // Y la CUENTA queda anotada en ese aparato y aplicación.
        expect(db.dispositivoPersona.upsert.mock.calls[0][0].where).toEqual({ dispositivoAppId_userId: { dispositivoAppId: 'da1', userId: 'u1' } })
    })

    it('sin la cabecera, o con una que no es un UUID, NO anota nada y la renovación es la de siempre', async () => {
        expect((await llamar(refresh, { refresh_token: 'a' })).status).toBe(200)
        expect((await llamar(refresh, { refresh_token: 'b' }, { 'x-aparato-id': 'no-soy-un-uuid' })).status).toBe(200)
        expect(db.dispositivoApp.upsert).not.toHaveBeenCalled()
    })

    it('un UUID v4 NUEVO no crea nada (hay que usar v7), pero uno que ya existe (importado) SÍ se actualiza', async () => {
        const V4 = '0f4c9c1e-8a3b-4d0e-9d62-6a1f3b6f2c10'
        db.dispositivoApp.findUnique.mockResolvedValue(null)
        expect((await llamar(refresh, { refresh_token: 'a' }, { 'x-aparato-id': V4 })).status).toBe(200)
        expect(db.dispositivoApp.upsert).not.toHaveBeenCalled()

        // existe (importado) y no está bloqueado
        db.dispositivoApp.findUnique.mockResolvedValue({ id: 'd-importado', dispositivoId: 'dis-i' })
        expect((await llamar(refresh, { refresh_token: 'b' }, { 'x-aparato-id': V4 })).status).toBe(200)
        expect(db.dispositivoApp.upsert).toHaveBeenCalledTimes(1)
        expect(db.dispositivoApp.upsert.mock.calls[0][0].where).toEqual({ clientId_aparatoId: { clientId: 'delivery-apk', aparatoId: V4 } })
    })

    it('si la tabla de dispositivos falla, la renovación SIGUE (ni 401 ni 500)', async () => {
        db.dispositivoApp.findUnique.mockRejectedValue(new Error('base caída'))
        const r = await llamar(refresh, { refresh_token: 'x' }, { 'x-aparato-id': ID })
        expect(r.status).toBe(200)
        expect(r.body.refresh_token).toEqual(expect.any(String))
    })

    it('un aparato BLOQUEADO recibe el 401 de siempre y NO se gasta su refresh', async () => {
        db.dispositivoApp.findFirst.mockResolvedValue({ id: 'da1' })
        const r = await llamar(refresh, { refresh_token: 'x' }, { 'x-aparato-id': ID })
        expect(r).toEqual({ status: 401, body: { error: 'invalid_refresh' } })
        // solo se MIRÓ de qué aplicación es el refresh; no se gastó ni se emitió nada
        expect(db.refreshToken.updateMany).not.toHaveBeenCalled()
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        expect(db.dispositivoApp.upsert).not.toHaveBeenCalled()
        // y se miró el bloqueo EN LA APLICACIÓN de ese refresh, no en todas
        expect(db.dispositivoApp.findFirst.mock.calls[0][0].where).toMatchObject({ clientId: 'delivery-apk', aparatoId: ID })
    })

    it('si no se puede comprobar el bloqueo, se DEJA PASAR (una caída no bloquea a nadie)', async () => {
        db.dispositivoApp.findFirst.mockRejectedValue(new Error('base caída'))
        expect((await llamar(refresh, { refresh_token: 'x' }, { 'x-aparato-id': ID })).status).toBe(200)
    })
})

describe('el bloqueo es POR APLICACIÓN', () => {
    it('que el CRM bloquee el aparato NO deja sin entrar a Reparto en el mismo teléfono', async () => {
        // la base solo tiene bloqueada la fila de `crm-apk`: la búsqueda va con la aplicación del refresh (`delivery-apk`)
        db.dispositivoApp.findFirst.mockImplementation(async ({ where }: { where: { clientId: string } }) =>
            where.clientId === 'crm-apk' ? { id: 'da-crm' } : null)
        expect((await llamar(refresh, { refresh_token: 'x' }, { 'x-aparato-id': ID })).status).toBe(200)
        // y el refresh que es de la APK del CRM sí se rechaza
        db.refreshToken.findUnique.mockResolvedValue({ ...FILA_DE_REFRESH, clientId: 'crm-apk' })
        expect((await llamar(refresh, { refresh_token: 'y' }, { 'x-aparato-id': ID })).status).toBe(401)
    })
})

describe('POST /api/auth/token con X-Aparato-Id', () => {
    it('anota el aparato al entrar', async () => {
        const r = await llamar(token, { email: 'maikel@procovar.local', password: 'buena' }, { 'x-aparato-id': ID })
        expect(r.status).toBe(200)
        expect(db.dispositivoApp.upsert.mock.calls[0][0].create).toMatchObject({ userId: 'u1', clientId: 'delivery-apk', aparatoId: ID })
    })

    it('un aparato bloqueado NO entra (403) y no deja sesión abierta', async () => {
        db.dispositivoApp.findFirst.mockResolvedValue({ id: 'da1' })
        const r = await llamar(token, { email: 'maikel@procovar.local', password: 'buena' }, { 'x-aparato-id': ID })
        expect(r).toEqual({ status: 403, body: { error: 'dispositivo_bloqueado' } })
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        expect(db.session.deleteMany).toHaveBeenCalled()
    })

    it('sin la cabecera todo es como antes', async () => {
        expect((await llamar(token, { email: 'maikel@procovar.local', password: 'buena' })).status).toBe(200)
        expect(db.dispositivoApp.upsert).not.toHaveBeenCalled()
    })
})
