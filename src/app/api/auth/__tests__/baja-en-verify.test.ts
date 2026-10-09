/**
 * Una persona dada de baja (`activo=false`) con la sesión (o un JWT) ya en la mano NO vale en
 * `verify-session` ni en `verify`. better-auth no mira esa columna: sin esto, las aplicaciones que
 * solo llaman a Accesos para validar seguirían aceptando a la baja hasta que caducara su cookie.
 *
 * La «base» de aquí RESPETA el `select` y el `where`: si el código deja de pedir `activo`, la
 * persona llega sin él y la prueba se pone roja (un mock que devolviera la fila entera lo taparía).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'


const base = vi.hoisted(() => ({
    personas: [] as Array<{ id: string; activo: boolean; defaultRole: { name: string } | null; members: unknown[] }>,
    caida: false,
}))
const db = vi.hoisted(() => ({
    session: { findUnique: vi.fn() },
    member: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))
const jwks = vi.hoisted(() => ({ verifyRs256: vi.fn() }))
const rbac = vi.hoisted(() => ({ resolveRbac: vi.fn() }))
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/jwks', () => jwks)
vi.mock('@/lib/logger', () => ({ logger }))
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/rbac/resolve-permissions', () => rbac)
vi.mock('@/lib/with-service-auth', () => ({
    // Sin la comprobación de servicio: aquí se prueba lo que SE DECIDE, no quién llama.
    withServiceAuth: (handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
        handler(req, { client: { clientId: 'app' } }),
}))

import { POST as verifySession } from '../verify-session/route'
import { POST as verify } from '../verify/route'

const peticion = (cuerpo: unknown) => ({ json: async () => cuerpo }) as never
const llamar = async (ruta: typeof verify, cuerpo: unknown) => {
    const res = (await ruta(peticion(cuerpo))) as Response
    return { status: res.status, cuerpo: await res.json() }
}

beforeEach(() => {
    vi.clearAllMocks()
    base.personas = [
        { id: 'u-alta', activo: true, defaultRole: { name: 'GESTOR' }, members: [] },
        { id: 'u-baja', activo: false, defaultRole: { name: 'GESTOR' }, members: [] },
    ]
    base.caida = false
    // findUnique respeta el `select`: solo devuelve lo que se le pidió.
    db.user.findUnique.mockImplementation(async (a: { where: { id: string }; select: Record<string, unknown> }) => {
        const fila = base.personas.find((p) => p.id === a.where.id)
        if (!fila) return null
        return Object.fromEntries(Object.entries(fila).filter(([k]) => k in a.select))
    })
    // findFirst respeta `where: { id: { in }, activo }`.
    db.user.findFirst.mockImplementation(async (a: { where: { id: { in: string[] }; activo?: boolean } }) => {
        if (base.caida) throw new Error('base caída')
        return base.personas.find((p) => a.where.id.in.includes(p.id) && (a.where.activo === undefined || p.activo === a.where.activo)) ?? null
    })
    db.session.findUnique.mockResolvedValue({ revokedAt: null })
    db.member.findMany.mockResolvedValue([])
    rbac.resolveRbac.mockResolvedValue({ global: ['x.ver'] })
    jwks.verifyRs256.mockResolvedValue({ sub: 'u-alta', purpose: 'svc:p' })
})

describe('verify-session', () => {
    const conSesionDe = (userId: string) =>
        betterAuth.getSession.mockResolvedValue({ user: { id: userId }, session: { id: 's1', activeOrganizationId: null } })
    const cuerpo = { sessionToken: 'x'.repeat(20) }

    it('una persona de BAJA con la sesión abierta recibe 401 invalid_session (la misma forma que una sesión inválida)', async () => {
        conSesionDe('u-baja')
        const r = await llamar(verifySession, cuerpo)
        expect(r.status).toBe(401)
        expect(r.cuerpo).toEqual({ error: 'invalid_session' })
        // No se entregó nada de la persona: ni membresías ni permisos.
        expect(db.member.findMany).not.toHaveBeenCalled()
        expect(rbac.resolveRbac).not.toHaveBeenCalled()
    })

    it('la consulta PIDE `activo` (si se quita el select, la baja pasaría)', async () => {
        conSesionDe('u-alta')
        await llamar(verifySession, cuerpo)
        expect(db.user.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ select: expect.objectContaining({ activo: true }) }),
        )
    })

    it('una persona activa sigue entrando igual: valid, rol y permisos', async () => {
        conSesionDe('u-alta')
        const r = await llamar(verifySession, cuerpo)
        expect(r.status).toBe(200)
        expect(r.cuerpo.valid).toBe(true)
        expect(r.cuerpo.role).toBe('GESTOR')
        expect(r.cuerpo.rbac.roles).toEqual(['GESTOR'])
        expect(r.cuerpo.rbac.permissions).toEqual(['x.ver'])
    })

    it('los demás 401 no cambian: sin sesión → invalid_session; revocada → session_revoked', async () => {
        betterAuth.getSession.mockResolvedValue(null)
        expect(await llamar(verifySession, cuerpo)).toEqual({ status: 401, cuerpo: { error: 'invalid_session' } })

        conSesionDe('u-alta')
        db.session.findUnique.mockResolvedValue({ revokedAt: new Date() })
        expect(await llamar(verifySession, cuerpo)).toEqual({ status: 401, cuerpo: { error: 'session_revoked' } })
    })

    it('si la base falla al comprobar, no se da por buena: 500 internal_error', async () => {
        conSesionDe('u-alta')
        db.user.findUnique.mockRejectedValue(new Error('base caída'))
        const r = await llamar(verifySession, cuerpo)
        expect(r.status).toBe(500)
        expect(r.cuerpo).toEqual({ error: 'internal_error' })
    })
})

describe('verify (JWT)', () => {
    const cuerpo = { token: 'x'.repeat(20), purpose: 'p' }

    it('un JWT cuyo `sub` es una persona de BAJA da 401 { valid:false } y no entrega el payload', async () => {
        jwks.verifyRs256.mockResolvedValue({ sub: 'u-baja' })
        const r = await llamar(verify, cuerpo)
        expect(r.status).toBe(401)
        expect(r.cuerpo).toEqual({ valid: false, error: 'user_inactive' })
    })

    it('lo mismo si la persona va en el claim `userId`', async () => {
        jwks.verifyRs256.mockResolvedValue({ sub: 'otra-cosa', userId: 'u-baja' })
        const r = await llamar(verify, cuerpo)
        expect(r.status).toBe(401)
        expect(r.cuerpo.valid).toBe(false)
    })

    it('una persona activa, un `sub` que no es de nadie (clientId) o sin ids: valid con su payload', async () => {
        for (const claims of [{ sub: 'u-alta' }, { sub: 'un-clientId' }, { orderId: '9' }]) {
            jwks.verifyRs256.mockResolvedValue(claims)
            const r = await llamar(verify, cuerpo)
            expect(r.status).toBe(200)
            expect(r.cuerpo).toEqual({ valid: true, payload: claims })
        }
    })

    it('sin ids no se toca la base', async () => {
        jwks.verifyRs256.mockResolvedValue({ orderId: '9' })
        await llamar(verify, cuerpo)
        expect(db.user.findFirst).not.toHaveBeenCalled()
    })

    it('un JWT inválido sigue dando 401 { valid:false, error: <mensaje> } sin mirar la base', async () => {
        jwks.verifyRs256.mockRejectedValue(new Error('JWT purpose mismatch'))
        const r = await llamar(verify, cuerpo)
        expect(r).toEqual({ status: 401, cuerpo: { valid: false, error: 'JWT purpose mismatch' } })
        expect(db.user.findFirst).not.toHaveBeenCalled()
    })

    it('si la base cae al comprobar la baja: cerrado, 503 service_unavailable (no valid:true)', async () => {
        jwks.verifyRs256.mockResolvedValue({ sub: 'u-alta' })
        base.caida = true
        const r = await llamar(verify, cuerpo)
        expect(r.status).toBe(503)
        expect(r.cuerpo).toEqual({ valid: false, error: 'service_unavailable' })
        expect(logger.error).toHaveBeenCalled()
    })
})

