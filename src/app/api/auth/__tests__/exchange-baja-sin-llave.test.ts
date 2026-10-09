/**
 * BAJO-4 (auditoría A1), de punta a punta en `/api/auth/exchange` con la puerta REAL: una cuenta de baja
 * (`activo=false`) canjeaba un código acuñado para un cliente SIN llave (asignacion, crm, rutas, portal,
 * procovar-sync...) porque `comprobarEntrada` salía con `true` antes de mirar la baja.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const codigo = vi.hoisted(() => ({ clientId: 'asignacion' }))
const db = vi.hoisted(() => ({ member: { findMany: vi.fn() }, user: { findUnique: vi.fn() } }))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/with-service-auth', () => ({
    withServiceAuth: (handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
        handler(req, { client: { clientId: 'procovar-sync' } }),
}))
vi.mock('@/lib/auth-code', () => ({
    consumeAuthCode: vi.fn(async () => ({ sessionToken: 'tok', returnTo: null, userId: 'u1', clientId: codigo.clientId })),
}))
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../exchange/route'
import { SIN_LLAVE } from '@/lib/puerta-de-entrada'

const canjear = async () => (await POST({ json: async () => ({ code: 'x'.repeat(40) }) } as never)) as Response

beforeEach(() => {
    vi.clearAllMocks()
    betterAuth.getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } })
    db.member.findMany.mockResolvedValue([])
})

describe.each(SIN_LLAVE)('código acuñado para %s', (cliente) => {
    beforeEach(() => {
        codigo.clientId = cliente
    })

    it('una BAJA no lo canjea: 401 invalid_or_expired_code y ni se mira la sesión', async () => {
        db.user.findUnique.mockResolvedValue({ activo: false, isSystemAdmin: true, defaultRole: null, members: [] })
        const res = await canjear()
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'invalid_or_expired_code' })
        expect(betterAuth.getSession).not.toHaveBeenCalled()
    })

    it('una cuenta activa SIGUE canjeándolo, sin pedir llave', async () => {
        db.user.findUnique.mockResolvedValue({ activo: true, isSystemAdmin: false, defaultRole: { name: 'GESTOR', permissions: [] }, members: [] })
        expect((await canjear()).status).toBe(200)
        expect(betterAuth.getSession).toHaveBeenCalledTimes(1)
    })
})
