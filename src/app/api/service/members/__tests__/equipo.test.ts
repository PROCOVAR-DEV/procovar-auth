/**
 * /api/service/members para el CRM (12/10/2026): el EQUIPO de un supervisor (`supervisorId`), el
 * lote de personas por id (`userIds`) y, en cada fila, `codigoVendedor`, `supervisorId` y `activo`.
 *
 * La «base» aplica de verdad el `where` (sucursal, ids y supervisor), así que un filtro que se
 * pierda por el camino devuelve gente de más y la prueba se pone roja.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = { organizationId: string; user: { id: string; name: string; email: string; activo: boolean; codigoVendedor: string | null; supervisorId: string | null }; rol: string }

const base = vi.hoisted(() => ({ filas: [] as Fila[] }))
const db = vi.hoisted(() => ({ member: { findMany: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/with-service-auth', () => ({ withServiceAuth: (h: unknown) => h }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../route'

const pedir = async (cuerpo: unknown) => {
    const res = await (POST as unknown as (r: Request) => Promise<Response>)(
        new Request('http://x/api/service/members', { method: 'POST', body: JSON.stringify(cuerpo) }),
    )
    return { status: res.status, cuerpo: await res.json() }
}
const persona = (id: string, extra: Partial<Fila['user']> = {}) =>
    ({ id, name: id, email: `${id}@p.local`, activo: true, codigoVendedor: null, supervisorId: null, ...extra })

beforeEach(() => {
    vi.clearAllMocks()
    base.filas = [
        { organizationId: 'cam', user: persona('sup', {}), rol: 'SUPERVISOR' },
        { organizationId: 'cam', user: persona('g1', { codigoVendedor: 'g.uno', supervisorId: 'sup' }), rol: 'GESTOR' },
        { organizationId: 'cam', user: persona('g2', { codigoVendedor: 'g.dos', supervisorId: 'sup', activo: false }), rol: 'GESTOR' },
        { organizationId: 'hab', user: persona('g3', { codigoVendedor: 'g.tres', supervisorId: 'otro' }), rol: 'GESTOR' },
        { organizationId: 'hab', user: persona('suelto'), rol: 'GESTOR' },
    ]
    db.member.findMany.mockImplementation(async ({ where }: { where: { organizationId?: string; userId?: { in: string[] }; user?: { supervisorId: string } } }) =>
        base.filas
            .filter((f) => !where.organizationId || f.organizationId === where.organizationId)
            .filter((f) => !where.userId || where.userId.in.includes(f.user.id))
            .filter((f) => !where.user || f.user.supervisorId === where.user.supervisorId)
            .map((f) => ({ organizationId: f.organizationId, user: f.user, organization: { name: f.organizationId, slug: f.organizationId }, memberRoles: [{ role: { name: f.rol } }] })),
    )
})

describe('el equipo de un supervisor', () => {
    it('sólo las personas con supervisorId = él, con su código y si siguen activas', async () => {
        const r = await pedir({ supervisorId: 'sup' })
        expect(r.status).toBe(200)
        expect(r.cuerpo.members.map((m: { id: string }) => m.id)).toEqual(['g1', 'g2'])
        expect(r.cuerpo.members[0]).toMatchObject({ codigoVendedor: 'g.uno', supervisorId: 'sup', activo: true, roles: ['GESTOR'] })
        expect(r.cuerpo.members[1]).toMatchObject({ activo: false })
    })

    it('un supervisor sin equipo: lista vacía, no error', async () => {
        expect((await pedir({ supervisorId: 'nadie' })).cuerpo).toEqual({ count: 0, members: [] })
    })
})

describe('un lote de personas por id', () => {
    it('código y nombre de esas, y de nadie más; la persona sin supervisor sale con `null`', async () => {
        const r = await pedir({ userIds: ['g3', 'suelto'] })
        expect(r.cuerpo.members).toEqual([
            expect.objectContaining({ id: 'g3', name: 'g3', codigoVendedor: 'g.tres', supervisorId: 'otro' }),
            expect.objectContaining({ id: 'suelto', codigoVendedor: null, supervisorId: null }),
        ])
    })

    it('más de 500 ids es 400', async () => {
        expect((await pedir({ userIds: Array.from({ length: 501 }, (_, i) => `u${i}`) })).status).toBe(400)
    })
})

it('sin filtros nuevos sigue devolviendo a todos, como antes (Rutas)', async () => {
    expect((await pedir({})).cuerpo.count).toBe(5)
})
