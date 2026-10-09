/**
 * /api/user/sesiones vista desde fuera: quién puede qué. La lógica fina está en
 * `lib/__tests__/sesiones-de-la-persona.test.ts`; aquí, el pegamento — de dónde sale la persona,
 * qué se lee, a qué camino se llama y que NADA ajeno se toca.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    session: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    refreshToken: { groupBy: vi.fn(), findFirst: vi.fn() },
}))
const sesionDeLaPeticion = vi.hoisted(() => ({ resolveSessionUser: vi.fn() }))
const betterAuth = vi.hoisted(() => ({
    revokeSession: vi.fn(async () => ({})),
    revokeOtherSessions: vi.fn(async () => ({})),
    revokeSessions: vi.fn(async () => ({})),
}))
const familias = vi.hoisted(() => ({ cerrarFamilia: vi.fn(async () => {}) }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/require-admin', () => sesionDeLaPeticion)
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/apk-tokens', () => familias)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { GET, POST } from '../route'
import { logger } from '@/lib/logger'

const ANA = { user: { id: 'ana', email: 'a@x' }, session: { id: 'actual', userId: 'ana', expiresAt: new Date() } }
const ahora = Date.now()
const fila = (o: Record<string, unknown>) => ({
    id: 'x', userId: 'ana', clientId: null, ipAddress: '1.1.1.1', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36',
    createdAt: new Date(ahora - 1e6), updatedAt: new Date(ahora - 1e5), expiresAt: new Date(ahora + 1e8), revokedAt: null, token: 'TOKEN-SECRETO', ...o,
})
const APP = 'https://auth.procovar.test'
process.env.APP_URL = APP
/** Una petición como la manda la propia aplicación: Origin suyo y cuerpo JSON. */
const peticion = (body: unknown, cabeceras: Record<string, string> = {}) =>
    ({ headers: new Headers({ cookie: 'c=1', origin: APP, 'content-type': 'application/json', ...cabeceras }), json: async () => body }) as never

beforeEach(() => {
    vi.clearAllMocks()
    sesionDeLaPeticion.resolveSessionUser.mockResolvedValue(ANA)
})

describe('sin sesión', () => {
    it('GET y POST contestan 401 y no tocan nada', async () => {
        sesionDeLaPeticion.resolveSessionUser.mockResolvedValue(null)
        expect((await GET()).status).toBe(401)
        expect((await POST(peticion({ accion: 'todas' }))).status).toBe(401)
        expect(betterAuth.revokeSessions).not.toHaveBeenCalled()
        expect(db.session.findMany).not.toHaveBeenCalled()
    })
})

describe('GET', () => {
    it('lista SOLO las de la persona de la cookie, marca la actual y no suelta ningún token', async () => {
        db.session.findMany.mockResolvedValue([fila({ id: 'actual' }), fila({ id: 'apk', clientId: 'delivery-apk' })])
        db.refreshToken.groupBy.mockResolvedValue([{ sessionId: 'apk', _max: { createdAt: new Date(ahora - 5) } }])
        const res = await GET()
        const cuerpo = await res.json()
        expect(db.session.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'ana', revokedAt: null })
        expect(db.refreshToken.groupBy.mock.calls[0][0].where).toMatchObject({ userId: 'ana' })
        expect(cuerpo.sesiones.map((s: { id: string; tipo: string; actual: boolean }) => [s.id, s.tipo, s.actual])).toEqual([
            ['actual', 'navegador', true],
            ['apk', 'aparato', false],
        ])
        expect(JSON.stringify(cuerpo)).not.toContain('TOKEN-SECRETO')
    })

    it('más de 100 sesiones: devuelve 100 y `truncada: true`; con 100 justas, `false`', async () => {
        const muchas = (n: number) => Array.from({ length: n }, (_, i) => fila({ id: `s${i}` }))
        db.refreshToken.groupBy.mockResolvedValue([])
        db.session.findMany.mockResolvedValue(muchas(101))
        let cuerpo = await (await GET()).json()
        expect(cuerpo.sesiones).toHaveLength(100)
        expect(cuerpo.truncada).toBe(true)
        expect(db.session.findMany.mock.calls[0][0].take).toBe(101) // se pide una de más para saberlo
        db.session.findMany.mockResolvedValue(muchas(100))
        cuerpo = await (await GET()).json()
        expect(cuerpo.sesiones).toHaveLength(100)
        expect(cuerpo.truncada).toBe(false)
    })

    it('si la base falla: 500 limpio, no revienta', async () => {
        db.session.findMany.mockRejectedValue(new Error('base caída'))
        expect((await GET()).status).toBe(500)
    })
})

describe('POST', () => {
    it('cuerpo inválido → 400', async () => {
        expect((await POST(peticion({ accion: 'borrar-todo' }))).status).toBe(400)
        expect((await POST(peticion({ accion: 'una' }))).status).toBe(400)
    })

    it('el id sólo admite [\\w-]{1,128}: NUL, comillas, barras y longitudes raras → 400 sin tocar la base', async () => {
        for (const id of ['a\u0000b', "x'; drop", 'a/b', 'a b', '', 'x'.repeat(129), '../etc', 'é']) {
            expect((await POST(peticion({ accion: 'una', id }))).status, JSON.stringify(id)).toBe(400)
        }
        expect(db.session.findUnique).not.toHaveBeenCalled()
        db.session.findUnique.mockResolvedValue(null)
        for (const id of ['abc', '0199-aaaa_bbbb', 'x'.repeat(128)]) {
            expect((await POST(peticion({ accion: 'una', id }))).status, id).toBe(404) // pasa la forma; no existe
        }
    })

    it('la sesión de OTRA persona → 404 y no se toca nada (ni better-auth, ni la familia, ni la base)', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'b1', userId: 'beto' }))
        db.refreshToken.findFirst.mockResolvedValue({ id: 'r' })
        const res = await POST(peticion({ accion: 'una', id: 'b1' }))
        expect(res.status).toBe(404)
        expect(betterAuth.revokeSession).not.toHaveBeenCalled()
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
        expect(db.session.updateMany).not.toHaveBeenCalled()
    })

    it('la actual: 409, no se revoca por aquí', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'actual' }))
        db.refreshToken.findFirst.mockResolvedValue(null)
        expect((await POST(peticion({ accion: 'una', id: 'actual' }))).status).toBe(409)
        expect(betterAuth.revokeSession).not.toHaveBeenCalled()
    })

    it('un navegador propio → revokeSession con su token', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'w2' }))
        db.refreshToken.findFirst.mockResolvedValue(null)
        expect((await POST(peticion({ accion: 'una', id: 'w2' }))).status).toBe(200)
        expect(betterAuth.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ body: { token: 'TOKEN-SECRETO' } }))
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
    })

    it('un dispositivo propio → cierra SU familia, sin pasar por better-auth', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'd1', clientId: 'delivery-apk' }))
        // 1ª: ¿tiene refresh? (buscar) · 2ª: su familia (cerrarAparato, buscada CON userId)
        db.refreshToken.findFirst.mockResolvedValueOnce({ id: 'r' }).mockResolvedValueOnce({ familyId: 'fam-1' })
        expect((await POST(peticion({ accion: 'una', id: 'd1' }))).status).toBe(200)
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam-1')
        expect(db.refreshToken.findFirst.mock.calls[1][0].where).toMatchObject({ userId: 'ana', sessionId: 'd1' })
        expect(betterAuth.revokeSession).not.toHaveBeenCalled()
    })

    it('«las demás» y «todas» van por los caminos de better-auth', async () => {
        expect((await POST(peticion({ accion: 'otras' }))).status).toBe(200)
        expect(betterAuth.revokeOtherSessions).toHaveBeenCalledOnce()
        expect((await POST(peticion({ accion: 'todas' }))).status).toBe(200)
        expect(betterAuth.revokeSessions).toHaveBeenCalledOnce()
    })

    it('un dispositivo cuya familia ya no está: NO se deja una fila «revocada» que better-auth ignora; se borra por better-auth', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'd2' }))
        // buscar: SÍ tenía refresh · cerrarAparato: ya no hay familia
        db.refreshToken.findFirst.mockResolvedValueOnce({ id: 'r' }).mockResolvedValueOnce(null)
        expect((await POST(peticion({ accion: 'una', id: 'd2' }))).status).toBe(200)
        expect(db.session.updateMany).not.toHaveBeenCalled()
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
        expect(betterAuth.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ body: { token: 'TOKEN-SECRETO' } }))
    })

    it('una sesión web con clientId «delivery-apk» y sin refresh se cierra como navegador (borrada por better-auth)', async () => {
        db.session.findUnique.mockResolvedValue(fila({ id: 'falsa', clientId: 'delivery-apk' }))
        db.refreshToken.findFirst.mockResolvedValue(null)
        expect((await POST(peticion({ accion: 'una', id: 'falsa' }))).status).toBe(200)
        expect(betterAuth.revokeSession).toHaveBeenCalledOnce()
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
        expect(db.session.updateMany).not.toHaveBeenCalled()
    })

    it('si better-auth falla: 500, sin fingir que se cerró', async () => {
        betterAuth.revokeSessions.mockRejectedValueOnce(new Error('boom'))
        expect((await POST(peticion({ accion: 'todas' }))).status).toBe(500)
    })
})

describe('POST: sólo lo manda esta aplicación (CSRF de mismo sitio)', () => {
    const intactos = () => {
        expect(betterAuth.revokeSession).not.toHaveBeenCalled()
        expect(betterAuth.revokeOtherSessions).not.toHaveBeenCalled()
        expect(betterAuth.revokeSessions).not.toHaveBeenCalled()
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
        expect(sesionDeLaPeticion.resolveSessionUser).not.toHaveBeenCalled()
    }

    it('un Origin distinto (otro subdominio de procovar.cloud, otro puerto, otro esquema, «null») → 403 y no se toca nada', async () => {
        for (const origin of ['https://evil.procovar.test', 'https://auth.procovar.test:8443', 'http://auth.procovar.test', 'null', 'https://procovar.test']) {
            const res = await POST(peticion({ accion: 'todas' }, { origin }))
            expect(res.status, origin).toBe(403)
        }
        intactos()
    })

    it('Content-Type que no es application/json (text/plain, formulario, vacío) → 415 y no se toca nada', async () => {
        for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
            const res = await POST(peticion({ accion: 'todas' }, { 'content-type': tipo }))
            expect(res.status, tipo).toBe(415)
        }
        intactos()
    })

    it('el Origin de la aplicación con `application/json; charset=utf-8` pasa', async () => {
        const res = await POST(peticion({ accion: 'todas' }, { 'content-type': 'application/json; charset=utf-8' }))
        expect(res.status).toBe(200)
        expect(betterAuth.revokeSessions).toHaveBeenCalledOnce()
    })

    it('sin cabecera Origin (cliente que no es un navegador) pasa si es JSON y hay sesión', async () => {
        const req = { headers: new Headers({ cookie: 'c=1', 'content-type': 'application/json' }), json: async () => ({ accion: 'otras' }) } as never
        expect((await POST(req)).status).toBe(200)
    })

    it('la lectura (GET) no cambia: no mira Origin ni Content-Type', async () => {
        db.session.findMany.mockResolvedValue([])
        db.refreshToken.groupBy.mockResolvedValue([])
        expect((await GET()).status).toBe(200)
    })
})

describe('POST: matriz Origin × APP_URL', () => {
    /** Una petición JSON con (o sin) `Origin`; `undefined` = sin la cabecera. */
    const con = (origin: string | undefined, cabeceras: Record<string, string> = {}) => {
        const h = new Headers({ cookie: 'c=1', 'content-type': 'application/json', ...cabeceras })
        if (origin !== undefined) h.set('origin', origin)
        return { headers: h, json: async () => ({ accion: 'todas' }) } as never
    }
    const conAppUrl = async (valor: string | undefined, f: () => Promise<void>) => {
        const antes = process.env.APP_URL
        if (valor === undefined) delete process.env.APP_URL
        else process.env.APP_URL = valor
        try {
            await f()
        } finally {
            process.env.APP_URL = antes
        }
    }

    it('APP_URL válida: el Origin propio, vacío y ausente pasan; el ajeno y «null» dan 403', async () => {
        for (const [origin, estado] of [[APP, 200], ['', 200], [undefined, 200], ['https://evil.procovar.test', 403], ['null', 403]] as const) {
            vi.clearAllMocks()
            sesionDeLaPeticion.resolveSessionUser.mockResolvedValue(ANA)
            const res = await POST(con(origin))
            expect(res.status, String(origin)).toBe(estado)
            expect(betterAuth.revokeSessions).toHaveBeenCalledTimes(estado === 200 ? 1 : 0)
        }
    })

    it('Origin vacío NO salta el Content-Type: sigue siendo 415', async () => {
        const res = await POST(con('', { 'content-type': 'text/plain' }))
        expect(res.status).toBe(415)
        expect(betterAuth.revokeSessions).not.toHaveBeenCalled()
    })

    it('APP_URL ausente: vale la de desarrollo (localhost:3500)', async () => {
        await conAppUrl(undefined, async () => {
            expect((await POST(con('http://localhost:3500'))).status).toBe(200)
            expect((await POST(con(''))).status).toBe(200)
            expect((await POST(con(APP))).status).toBe(403)
        })
    })

    it('APP_URL mal puesta (texto, vacía, sin esquema, origen opaco): 500 con el motivo en el registro, sin TypeError y sin tocar nada', async () => {
        for (const mala of ['esto no es una url', '', 'auth.procovar.test', 'file:///tmp/x', 'data:text/plain,hola']) {
            await conAppUrl(mala, async () => {
                for (const origin of [APP, 'null', '', undefined, 'https://evil.procovar.test']) {
                    vi.clearAllMocks()
                    const res = await POST(con(origin))
                    expect(res.status, `${mala} / ${origin}`).toBe(500)
                    expect(await res.json()).toEqual({ error: 'internal_error' })
                    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('APP_URL'))
                    expect(betterAuth.revokeSessions).not.toHaveBeenCalled()
                    expect(sesionDeLaPeticion.resolveSessionUser).not.toHaveBeenCalled()
                }
            })
        }
    })
})
