/**
 * LA PUERTA TAMBIÉN AL RENOVAR, y la sesión sobrante de un acceso denegado.
 *
 *  - `/api/auth/refresh` pide la misma llave que el login (`delivery.entrar`). Sin ella
 *    403 `sin_permiso` y NO se gasta el refresh; con ella, todo igual que antes.
 *  - Si la BASE no contesta al comprobarla NO es «sin permiso»: 503 `comprobacion_no_disponible`
 *    (la app de Reparto toma el 403 por «perdiste el permiso» y no reintenta), y el refresh
 *    no se gasta. Una cuenta de baja sin la llave sigue siendo 401/`revoked`, no 403.
 *  - `/api/auth/token`, al denegar (sin permiso, sin sucursal, de baja…) borra la sesión
 *    de better-auth que acaba de abrir ESE intento, y sólo esa.
 *
 * `renovar` va de verdad, sobre una fila de refresh en memoria; sólo Prisma, el limitador
 * y la auditoría son dobles. Las reglas del refresh en sí están en `lib/__tests__/apk-tokens.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    session: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ signInEmail: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn(async () => ({ allowed: true, remaining: 10 })) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST as refresh } from '../refresh/route'
import { POST as token } from '../token/route'
import { SEGUNDOS_ACCESO, SEGUNDOS_REFRESH } from '@/lib/apk-tokens'
import { audit } from '@/lib/audit'

const REFRESH = 'el-refresh-de-la-apk'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const DIA = 24 * 60 * 60

/** La persona tal y como la leen `resolverIdentidad` Y `accesoDe` (la misma consulta falsa). */
const persona = (llaves: string[], extra: Record<string, unknown> = {}) => ({
    id: 'u1',
    name: 'Yasmani',
    email: 'y@procovar.local',
    username: 'yasmani',
    activo: true,
    isSystemAdmin: false,
    defaultRole: { name: 'LOGISTICO', permissions: llaves.map((key) => ({ permission: { key } })) },
    members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [{ role: { name: 'LOGISTICO', permissions: [] } }] }],
    ...extra,
})

/** Una fila de refresh en memoria cuyo `updateMany` respeta las condiciones del `where`. */
function filaDeRefresh(extra: Record<string, unknown> = {}) {
    const estado: Record<string, unknown> = {
        id: 'rt1',
        userId: 'u1',
        sessionId: 's1',
        familyId: 'fam1',
        clientId: 'delivery-apk',
        expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000),
        usedAt: null,
        revokedAt: null,
        graceUsedAt: null,
        ...extra,
    }
    db.refreshToken.findUnique.mockImplementation((async ({ where }: never) =>
        (where as { tokenHash?: string }).tokenHash === sha256(REFRESH) || (where as { id?: string }).id === 'rt1'
            ? { ...estado }
            : null) as never)
    db.refreshToken.updateMany.mockImplementation((async ({ where, data }: never) => {
        const w = where as Record<string, unknown>
        if (!w.id) return { count: 1 }
        if (!Object.entries(w).every(([k, v]) => estado[k] === v)) return { count: 0 }
        Object.assign(estado, data as object)
        return { count: 1 }
    }) as never)
    return estado
}

const pedirRefresh = async () => {
    const res = await refresh({ headers: new Headers({ 'user-agent': 'reparto/1.0' }), json: async () => ({ refresh: REFRESH }) } as never)
    return { status: res.status, body: await res.json() }
}

beforeEach(() => {
    vi.resetAllMocks()
    db.session.findUnique.mockResolvedValue({ revokedAt: null })
    db.session.updateMany.mockResolvedValue({ count: 1 })
    db.refreshToken.update.mockResolvedValue({})
    db.refreshToken.findFirst.mockResolvedValue({ sessionId: 's1' })
    let n = 0
    db.refreshToken.create.mockImplementation((async () => ({ id: `nueva${++n}` })) as never)
})

describe('POST /api/auth/refresh — la puerta', () => {
    it('CON delivery.entrar renueva igual que antes: par nuevo, refresh gastado', async () => {
        const fila = filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))

        const r = await pedirRefresh()

        expect(r.status).toBe(200)
        expect(r.body.token).toEqual(expect.any(String))
        expect(r.body.refresh_token).toEqual(expect.any(String))
        expect(r.body.refresh_token).not.toBe(REFRESH)
        expect(fila.usedAt).toBeInstanceOf(Date)
        expect(db.refreshToken.create).toHaveBeenCalledTimes(1)
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.denied' }))
    })

    it('SIN delivery.entrar: 403 sin_permiso, NO renueva y NO gasta el refresh', async () => {
        const fila = filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar']))

        const r = await pedirRefresh()

        expect(r.status).toBe(403)
        expect(r.body).toEqual({ error: 'sin_permiso', codigo: 'sin_permiso', message: 'No tienes permiso para entrar a Reparto.' })
        expect(r.body.token).toBeUndefined()
        expect(fila.usedAt).toBeNull()
        expect(fila.revokedAt).toBeNull()
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        expect(db.session.updateMany).not.toHaveBeenCalled()
        expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.apk.denied', userId: 'u1', clientId: 'delivery-apk' }),
        )
    })

    it('si se la devuelven, el MISMO refresh vuelve a valer (no se gastó)', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona([]))
        expect((await pedirRefresh()).status).toBe(403)

        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        expect((await pedirRefresh()).status).toBe(200)
    })

    it('el administrador de sistema renueva sin llaves', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona([], { isSystemAdmin: true }))
        expect((await pedirRefresh()).status).toBe(200)
    })

    it('si la base falla al comprobar la llave: 503, NO es «sin permiso», y el refresh NO se gasta', async () => {
        const fila = filaDeRefresh()
        db.user.findUnique.mockRejectedValueOnce(new Error('base caída')).mockResolvedValue(persona(['delivery.entrar']))

        const r = await pedirRefresh()

        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(r.body.codigo).toBeUndefined()
        expect(fila.usedAt).toBeNull()
        expect(fila.revokedAt).toBeNull()
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        expect(db.session.updateMany).not.toHaveBeenCalled()
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.denied' }))

        // Y al reintentar, cuando la base vuelve, el MISMO refresh renueva.
        expect((await pedirRefresh()).status).toBe(200)
    })

    it('la vía de la gracia con la base caída: 503 y NO se gasta la gracia', async () => {
        const fila = filaDeRefresh({ usedAt: new Date(Date.now() - 10_000) })
        db.user.findUnique.mockRejectedValue(new Error('base caída'))

        const r = await pedirRefresh()

        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(fila.graceUsedAt).toBeNull()
        expect(db.refreshToken.create).not.toHaveBeenCalled()
    })

    it('una cuenta de baja sin la llave: 401 (la cierra resolverIdentidad), NO 403 sin_permiso', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar'], { activo: false }))

        const r = await pedirRefresh()

        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_refresh' })
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.denied' }))
    })

    describe('la llave que se pide es la del cliente GUARDADO en la fila', () => {
        it('una fila de procovar-rutas se renueva con rutas.entrar, no con delivery.entrar', async () => {
            filaDeRefresh({ clientId: 'procovar-rutas' })
            db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
            expect((await pedirRefresh()).status).toBe(403)

            db.user.findUnique.mockResolvedValue(persona(['rutas.entrar']))
            expect((await pedirRefresh()).status).toBe(200)
        })

        it('una fila sin clientId (anterior a la columna) es delivery-apk', async () => {
            filaDeRefresh({ clientId: null })
            db.user.findUnique.mockResolvedValue(persona(['rutas.entrar']))
            expect((await pedirRefresh()).status).toBe(403)

            db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
            expect((await pedirRefresh()).status).toBe(200)
        })
    })

    it('la vía de la gracia (la respuesta se perdió) también pide la llave, y no gasta la gracia', async () => {
        const fila = filaDeRefresh({ usedAt: new Date(Date.now() - 10_000) })
        db.user.findUnique.mockResolvedValue(persona([]))

        const r = await pedirRefresh()

        expect(r.status).toBe(403)
        expect(fila.graceUsedAt).toBeNull()
        expect(db.refreshToken.create).not.toHaveBeenCalled()
    })

    it('un refresh ya caducado sigue siendo 401, no 403', async () => {
        filaDeRefresh({ expiresAt: new Date(Date.now() - 1000) })
        db.user.findUnique.mockResolvedValue(persona([]))
        expect((await pedirRefresh()).status).toBe(401)
    })

    it('un refresh REUTILIZADO fuera de la ventana sigue siendo robo aunque la persona no tenga la llave', async () => {
        filaDeRefresh({ usedAt: new Date(Date.now() - 10 * 60_000) })
        db.user.findUnique.mockResolvedValue(persona([]))
        expect((await pedirRefresh()).status).toBe(401)
        expect(db.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date), expiresAt: expect.any(Date) } }))
    })
})

describe('cuánto dura la sesión de la APK (valores reales)', () => {
    it('acceso 15 min; refresh 30 días; y vale más de dos días', () => {
        expect(SEGUNDOS_ACCESO).toBe(15 * 60)
        expect(SEGUNDOS_REFRESH).toBe(30 * DIA)
        expect(SEGUNDOS_REFRESH).toBeGreaterThanOrEqual(2 * DIA)
    })

    it('cada renovación ROTA el refresh y vuelve a estirar 30 días el refresh nuevo Y la sesión', async () => {
        filaDeRefresh({ expiresAt: new Date(Date.now() + 1 * DIA * 1000) }) // a un día de caducar
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        const antes = Date.now()

        const r = await pedirRefresh()

        expect(r.status).toBe(200)
        expect(r.body.refresh_expires_in).toBe(30 * DIA)
        const nuevo = db.refreshToken.create.mock.calls[0][0].data.expiresAt as Date
        expect(nuevo.getTime()).toBeGreaterThanOrEqual(antes + 30 * DIA * 1000 - 5000)
        const sesion = db.session.updateMany.mock.calls.find((c) => c[0].data.expiresAt)![0].data.expiresAt as Date
        expect(sesion.getTime()).toBeGreaterThanOrEqual(antes + 30 * DIA * 1000 - 5000)
    })
})

describe('POST /api/auth/token — la sesión de un acceso denegado se descarta', () => {
    const entrar = async () => {
        const res = await token({ headers: new Headers({ 'user-agent': 'reparto/1.0' }), json: async () => ({ email: 'y@procovar.local', password: 'buena' }) } as never)
        return { status: res.status, body: await res.json() }
    }
    const borradas = () => db.session.deleteMany.mock.calls.map((c) => c[0])

    beforeEach(() => {
        betterAuth.signInEmail.mockResolvedValue({ token: 'tok-de-este-intento' })
        db.session.findUnique.mockResolvedValue({ id: 's-nueva', userId: 'u1' })
        db.session.deleteMany.mockResolvedValue({ count: 1 })
    })

    it('sin_permiso: se borra ESA sesión (por su id, nunca por la persona)', async () => {
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar']))
        const r = await entrar()
        expect(r.status).toBe(403)
        expect(r.body.codigo).toBe('sin_permiso')
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
        expect(db.refreshToken.create).not.toHaveBeenCalled()
    })

    it('sin_sucursal: también se borra', async () => {
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar'], { members: [] }))
        const r = await entrar()
        expect(r.status).toBe(403)
        expect(r.body.error).toBe('sin_sucursal')
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
    })

    it('cuenta de baja: también se borra', async () => {
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar'], { activo: false }))
        const r = await entrar()
        expect(r.status).toBe(403)
        expect(r.body.error).toBe('revoked')
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
    })

    it('un fallo nuestro tras entrar (500) tampoco deja la sesión', async () => {
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        db.refreshToken.create.mockRejectedValue(new Error('base caída'))
        const r = await entrar()
        expect(r.status).toBe(500)
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
    })

    it('PERMITIDO: la sesión queda intacta (ni se borra ni se revoca) y se le estira', async () => {
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        const r = await entrar()
        expect(r.status).toBe(200)
        expect(db.session.deleteMany).not.toHaveBeenCalled()
        expect(db.session.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 's-nueva' }, data: expect.objectContaining({ clientId: 'delivery-apk' }) }),
        )
    })

    it('contraseña mala: no hay sesión que descartar (y no se toca ninguna)', async () => {
        betterAuth.signInEmail.mockRejectedValue(new Error('Invalid password'))
        const r = await entrar()
        expect(r.status).toBe(401)
        expect(db.session.deleteMany).not.toHaveBeenCalled()
    })

    it('la base caída al comprobar la llave: 503 (no 403), sin par, y la sesión también se descarta', async () => {
        db.user.findUnique.mockRejectedValue(new Error('base caída'))
        const r = await entrar()
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.denied' }))
    })

    it('cuenta de baja SIN la llave: 403 revoked (la puerta la deja pasar), no sin_permiso', async () => {
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar'], { activo: false }))
        const r = await entrar()
        expect(r.status).toBe(403)
        expect(r.body.error).toBe('revoked')
        expect(r.body.codigo).toBeUndefined()
        expect(borradas()).toEqual([{ where: { id: 's-nueva' } }])
    })

    it('si el borrado falla, la respuesta sigue siendo la misma denegación', async () => {
        db.user.findUnique.mockResolvedValue(persona([]))
        db.session.deleteMany.mockRejectedValue(new Error('base caída'))
        const r = await entrar()
        expect(r.status).toBe(403)
        expect(r.body.codigo).toBe('sin_permiso')
    })
})
