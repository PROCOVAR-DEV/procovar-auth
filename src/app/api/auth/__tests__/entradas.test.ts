/**
 * `entradas`: las llaves de entrada `<app>.entrar` que Accesos FIRMA de cada persona.
 *
 * Auth manda en lo que cada persona ve y puede hacer en cada aplicación, y el servidor de
 * Reparto decide por lo que Auth le firma: entra si y sólo si trae `delivery.entrar`. El
 * contrato es fijo y las dos vías tienen que decir LO MISMO:
 *
 *  - el JWT de acceso de la APK y del escritorio (`apk-tokens.ts`, se re-firma en cada
 *    renovación), y
 *  - la respuesta de `/api/auth/exchange` (campo de primer nivel, junto a `role`/`roles`).
 *
 * SIEMPRE presente: `[]` significa «no entra a nada», y Reparto lo trata distinto de «ausente».
 * Aquí también va el cable de la puerta DENTRO del exchange (la galleta de flujo no está firmada).
 *
 * Los roles son los DE VERDAD (`systemRolePermissionKeys`), no llaves inventadas: si mañana se
 * le da `delivery.entrar` al Gerente, estas pruebas lo cuentan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeJwt } from 'jose'
import { systemRolePermissionKeys } from '@/rbac/system-roles'

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})

const db = vi.hoisted(() => ({
    member: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    refreshToken: { create: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))
const codigos = vi.hoisted(() => ({ consumeAuthCode: vi.fn() }))
const auditoria = vi.hoisted(() => ({ audit: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/with-service-auth', () => ({
    // Sin la comprobación de servicio: aquí se prueba lo que SALE, no quién llama.
    withServiceAuth: (handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
        handler(req, { client: { clientId: 'reparto' } }),
}))
vi.mock('@/lib/auth-code', () => codigos)
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/lib/audit', () => auditoria)
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST as exchange } from '../exchange/route'
import { emitirPar } from '@/lib/apk-tokens'
import { LLAVES_DE_ENTRADA } from '@/lib/puerta-de-entrada'

const rol = (name: string) => ({
    name,
    permissions: systemRolePermissionKeys(name).map((key) => ({ permission: { key } })),
})

/** La persona tal y como la leen el exchange, `resolverIdentidad` Y `accesoDe` (una sola consulta falsa). */
const laPersonaEs = (o: { porDefecto?: string; membresias?: string[]; admin?: boolean; llaves?: string[] } = {}) =>
    db.user.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'Yasmani',
        email: 'y@procovar.local',
        username: 'yasmani',
        activo: true,
        isSystemAdmin: o.admin ?? false,
        defaultRole: o.llaves
            ? { name: 'A_MEDIDA', permissions: o.llaves.map((key) => ({ permission: { key } })) }
            : o.porDefecto
              ? rol(o.porDefecto)
              : null,
        members: [
            {
                organization: { codigo: 'CAM', activa: true },
                memberRoles: (o.membresias ?? []).map((n) => ({ role: rol(n) })),
            },
        ],
    })

const porExchange = async () => {
    const res = (await exchange({ json: async () => ({ code: 'x'.repeat(40) }) } as never)) as Response
    return { status: res.status, body: await res.json() }
}
const porLaApk = async () => decodeJwt((await emitirPar({ userId: 'u1', sessionId: 's1' })).token)

/** Lo que firman las dos vías para la misma persona. */
async function lasDosVias() {
    const [web, apk] = [await porExchange(), await porLaApk()]
    expect(web.status).toBe(200)
    return { web: web.body.entradas, apk: apk.entradas }
}

beforeEach(() => {
    vi.resetAllMocks()
    betterAuth.getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } })
    db.member.findMany.mockResolvedValue([])
    db.refreshToken.create.mockResolvedValue({ id: 'r1' })
    codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId: 'reparto', sessionToken: 'tok', returnTo: null })
})

describe('el exchange ante una caída de la base al comprobar la puerta', () => {
    it('devuelve 503 comprobacion_no_disponible (no «código inválido» ni «sin permiso»)', async () => {
        db.user.findUnique.mockRejectedValue(new Error('conexión caída'))
        const r = await porExchange()
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
    })

    it('pareja: una persona SIN la llave sigue siendo 401 invalid_or_expired_code', async () => {
        laPersonaEs({ porDefecto: 'GERENTE', membresias: ['GERENTE'] }) // reparto exige delivery.entrar
        const r = await porExchange()
        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_or_expired_code' })
    })
})

describe('entradas: lo que firman el exchange y el JWT de la APK', () => {
    it('LOGISTICO (tiene delivery.entrar): está, y es lo único', async () => {
        laPersonaEs({ porDefecto: 'LOGISTICO', membresias: ['LOGISTICO'] })
        const { web, apk } = await lasDosVias()
        expect(web).toEqual(['delivery.entrar'])
        expect(apk).toEqual(['delivery.entrar'])
    })

    it('GERENTE actual (sin delivery.entrar): no está, pero el campo existe con lo demás', async () => {
        laPersonaEs({ porDefecto: 'GERENTE', membresias: ['GERENTE'] })
        // El exchange canjea con el cliente de la prueba (`reparto`): el Gerente no entra a Reparto, así
        // que aquí se mira lo que se FIRMA con otro cliente, y el JWT se mira tal cual.
        codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId: 'pedido', sessionToken: 'tok', returnTo: null })
        const { web, apk } = await lasDosVias()
        expect(web).toEqual(['pedido.entrar', 'analitics.entrar', 'aft.entrar', 'ccsa.entrar', 'rutas.entrar'])
        expect(web).not.toContain('delivery.entrar')
        expect(apk).toEqual(web)
    })

    it('una persona sin ninguna llave (ANALISTA, o sin rol): `[]`, PRESENTE y no ausente', async () => {
        // `asignacion` no tiene llave: el exchange no la corta y se puede ver qué se firma.
        codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId: 'asignacion', sessionToken: 'tok', returnTo: null })
        for (const o of [{ porDefecto: 'ANALISTA', membresias: ['ANALISTA'] }, {}]) {
            laPersonaEs(o)
            const web = (await porExchange()).body
            const apk = await porLaApk()
            expect(web).toHaveProperty('entradas', [])
            expect(apk).toHaveProperty('entradas', [])
        }
    })

    it('isSystemAdmin (SUPER ADMIN): TODAS, aunque no traiga rol ni llaves', async () => {
        laPersonaEs({ admin: true })
        const { web, apk } = await lasDosVias()
        expect(web).toEqual([...LLAVES_DE_ENTRADA])
        expect(apk).toEqual([...LLAVES_DE_ENTRADA])
        expect(web).toHaveLength(7)
    })

    it('dos roles (rol por defecto + varias membresías): la UNIÓN, sin duplicados y en el orden del mapa', async () => {
        laPersonaEs({ porDefecto: 'GESTOR', membresias: ['LOGISTICO', 'ECONOMICA', 'LOGISTICO'] })
        const { web, apk } = await lasDosVias()
        expect(web).toEqual(['pedido.entrar', 'aft.entrar', 'delivery.entrar'])
        expect(apk).toEqual(web)
    })

    it('el exchange y el JWT dicen lo mismo para TODOS los roles de sistema', async () => {
        // `asignacion` (sin llave) para que el exchange no corte a quien no entra a Reparto.
        codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId: 'asignacion', sessionToken: 'tok', returnTo: null })
        for (const nombre of ['DESARROLLADOR', 'SUPER ADMIN', 'ADMINISTRADOR', 'GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR', 'ECONOMICA', 'ANALISTA', 'LOGISTICO']) {
            laPersonaEs({ porDefecto: nombre, membresias: [nombre] })
            const { web, apk } = await lasDosVias()
            expect(apk, nombre).toEqual(web)
            expect(Array.isArray(web), nombre).toBe(true)
        }
    })

    it('el JWT no crece de forma absurda: como mucho siete cadenas `<app>.entrar`', async () => {
        laPersonaEs({ admin: true, porDefecto: 'DESARROLLADOR', membresias: ['DESARROLLADOR', 'SUPER ADMIN', 'GERENTE'] })
        const claims = await porLaApk()
        expect(claims.entradas as string[]).toHaveLength(7)
        expect(new Set(claims.entradas as string[]).size).toBe(7)
        for (const k of claims.entradas as string[]) expect(k).toMatch(/^[a-z]+\.entrar$/)
    })

    it('el resto de campos del JWT no cambia: sólo se suma `entradas`', async () => {
        laPersonaEs({ porDefecto: 'LOGISTICO', membresias: ['LOGISTICO'] })
        const c = await porLaApk()
        expect(Object.keys(c).sort()).toEqual(
            ['branch_id', 'email', 'entradas', 'exp', 'iat', 'iss', 'jti', 'name', 'purpose', 'role', 'roles', 'sid', 'sub', 'sucursal', 'sucursales'].sort(),
        )
        expect(c.role).toBe('LOGISTICO')
        expect(c.roles).toEqual(['LOGISTICO'])
        expect(c.sucursal).toBe('CAM')
    })

    it('el exchange sigue devolviendo lo de antes (sesión, membresías, role, roles, sessionToken, returnTo)', async () => {
        laPersonaEs({ porDefecto: 'LOGISTICO', membresias: ['LOGISTICO'] })
        const { body } = await porExchange()
        expect(body).toMatchObject({ user: { id: 'u1' }, session: { id: 's1' }, memberships: [], role: 'LOGISTICO', roles: ['LOGISTICO'], sessionToken: 'tok', returnTo: null })
        expect(Object.keys(body).sort()).toEqual(['entradas', 'memberships', 'returnTo', 'role', 'roles', 'session', 'sessionToken', 'user'])
    })
})

describe('/api/auth/exchange repite la puerta', () => {
    it('SIN la llave: no devuelve la sesión (401 como un código inválido) y se audita', async () => {
        laPersonaEs({ porDefecto: 'GERENTE', membresias: ['GERENTE'] })

        const r = await porExchange()

        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_or_expired_code' })
        expect(betterAuth.getSession).not.toHaveBeenCalled()
        expect(auditoria.audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.code.denied', clientId: 'reparto', userId: 'u1', meta: expect.objectContaining({ via: 'exchange' }) }),
        )
        expect(auditoria.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.code.exchange' }))
    })

    it('CON la llave, y el administrador de sistema: todo igual que antes', async () => {
        laPersonaEs({ porDefecto: 'LOGISTICO', membresias: ['LOGISTICO'] })
        expect((await porExchange()).status).toBe(200)
        laPersonaEs({ admin: true })
        expect((await porExchange()).status).toBe(200)
    })

    it('un cliente SIN llave (asignacion) canjea como siempre, tenga la persona las llaves que tenga', async () => {
        codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId: 'asignacion', sessionToken: 'tok', returnTo: null })
        laPersonaEs({ porDefecto: 'ANALISTA' })
        const r = await porExchange()
        expect(r.status).toBe(200)
        expect(r.body.entradas).toEqual([])
    })

    it('cada aplicación con llave canjea con la suya y sólo con la suya', async () => {
        laPersonaEs({ llaves: ['aft.entrar'] })
        const canjear = async (clientId: string) => {
            codigos.consumeAuthCode.mockResolvedValue({ userId: 'u1', clientId, sessionToken: 'tok', returnTo: null })
            return (await porExchange()).status
        }
        expect(await canjear('aft')).toBe(200)
        expect(await canjear('pedido')).toBe(401)
        expect(await canjear('procovar-rutas')).toBe(401)
        expect(await canjear('reparto')).toBe(401)
    })

    it('si la base falla al comprobar: no devuelve la sesión (falla cerrado) y dice 503, no 401', async () => {
        db.user.findUnique.mockRejectedValue(new Error('base caída'))
        const r = await porExchange()
        expect(r.status).toBe(503)
        expect(betterAuth.getSession).not.toHaveBeenCalled()
    })

    it('un código inválido sigue siendo 401 y no mira a nadie', async () => {
        codigos.consumeAuthCode.mockResolvedValue(null)
        const r = await porExchange()
        expect(r.status).toBe(401)
        expect(db.user.findUnique).not.toHaveBeenCalled()
    })
})
