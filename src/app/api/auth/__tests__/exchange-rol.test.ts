/**
 * `/api/auth/exchange` devuelve el rol de la PERSONA con su nombre de Procovar.
 *
 * Es lo que lee cada aplicación al canjear el código del login. Se prueba con
 * LOGISTICO (08/10/2026) porque es lo que consume el reparto para decidir quién entra:
 * si el nombre se perdiera o se tradujera por el camino, el logístico se quedaría en la
 * puerta sin que nada fallara.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    member: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/with-service-auth', () => ({
    // Sin la comprobación de servicio: aquí se prueba lo que SALE, no quién llama.
    withServiceAuth: (handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
        handler(req, { client: { clientId: 'reparto' } }),
}))
vi.mock('@/lib/auth-code', () => ({
    consumeAuthCode: vi.fn(async () => ({ sessionToken: 'tok', returnTo: null })),
}))
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { POST } from '../exchange/route'

beforeEach(() => {
    vi.clearAllMocks()
    betterAuth.getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } })
    db.member.findMany.mockResolvedValue([
        { id: 'm1', role: 'LOGISTICO', createdAt: new Date(), organization: { id: 'o1', name: 'Holguín', slug: 'hol', logo: null } },
    ])
})

describe('el canje del código devuelve el rol con el nombre de Procovar', () => {
    it('un LOGISTICO sale como LOGISTICO, y su membresía sigue yendo', async () => {
        db.user.findUnique.mockResolvedValue({
            defaultRole: { name: 'LOGISTICO' },
            members: [{ memberRoles: [{ role: { name: 'LOGISTICO' } }] }],
        })
        const res = await POST({ json: async () => ({ code: 'x'.repeat(40) }) } as never)
        const body = await (res as Response).json()
        expect(body.role).toBe('LOGISTICO')
        expect(body.roles).toEqual(['LOGISTICO']) // el de la persona y el de su membresía, sin repetir
        expect(body.memberships[0].organization.slug).toBe('hol')
    })

    // Una cuenta isSystemAdmin puede no traer rol por defecto ni membresía. La web del
    // reparto ya le añade SUPER ADMIN, y por aquí salía `role: null` y `roles: []`.
    describe('una cuenta isSystemAdmin sale como SUPER ADMIN aunque no traiga rol', () => {
        const llamar = async () =>
            (await ((await POST({ json: async () => ({ code: 'x'.repeat(40) }) } as never)) as Response).json())

        beforeEach(() => db.member.findMany.mockResolvedValue([]))

        it('sin rol ni membresía', async () => {
            db.user.findUnique.mockResolvedValue({ isSystemAdmin: true, defaultRole: null, members: [] })
            const body = await llamar()
            expect(body.role).toBe('SUPER ADMIN')
            expect(body.roles).toEqual(['SUPER ADMIN'])
        })

        it('si ya lo trae no se repite', async () => {
            db.user.findUnique.mockResolvedValue({
                isSystemAdmin: true,
                defaultRole: { name: 'SUPER ADMIN' },
                members: [{ memberRoles: [{ role: { name: 'SUPER ADMIN' } }] }],
            })
            const body = await llamar()
            expect(body.role).toBe('SUPER ADMIN')
            expect(body.roles).toEqual(['SUPER ADMIN'])
        })

        it('con otro rol por defecto, éste sigue de principal y SUPER ADMIN se suma', async () => {
            db.user.findUnique.mockResolvedValue({ isSystemAdmin: true, defaultRole: { name: 'LOGISTICO' }, members: [] })
            const body = await llamar()
            expect(body.role).toBe('LOGISTICO')
            expect(body.roles).toEqual(['LOGISTICO', 'SUPER ADMIN'])
        })

        it('sin rol por defecto y con rol de membresía, `role` sigue siendo null (no «el primero que salga»)', async () => {
            db.user.findUnique.mockResolvedValue({
                isSystemAdmin: false,
                defaultRole: null,
                members: [{ memberRoles: [{ role: { name: 'LOGISTICO' } }] }],
            })
            const body = await llamar()
            expect(body.role).toBeNull()
            expect(body.roles).toEqual(['LOGISTICO'])
        })

        it('quien no es administrador del sistema no lo recibe nunca', async () => {
            db.user.findUnique.mockResolvedValue({ isSystemAdmin: false, defaultRole: null, members: [] })
            const body = await llamar()
            expect(body.role).toBeNull()
            expect(body.roles).toEqual([])
        })
    })
})
