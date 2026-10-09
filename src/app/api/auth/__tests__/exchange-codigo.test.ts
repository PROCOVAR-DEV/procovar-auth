/**
 * `/api/auth/exchange` manda el `codigo` de la sucursal (organization.codigo) ADEMÁS del `slug`.
 *
 * La web de Reparto lee el código; antes deducía de `slug` en mayúsculas, y eso falla donde el slug
 * no es el código (PLS tiene slug `palma-soriano`). Aditivo: no se quita nada de lo que ya salía.
 *
 * La «base» de aquí RESPETA el `select` anidado: si se quita `codigo` del select, la prueba se pone roja.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fila = Record<string, unknown>
type Seleccion = Record<string, unknown>

const filas = vi.hoisted(() => ({ miembros: [] as Array<Record<string, unknown>> }))
const db = vi.hoisted(() => ({
    member: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/with-service-auth', () => ({
    withServiceAuth: (handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
        handler(req, { client: { clientId: 'reparto' } }),
}))
vi.mock('@/lib/auth-code', () => ({
    consumeAuthCode: vi.fn(async () => ({ sessionToken: 'tok', returnTo: null, userId: 'u1', clientId: 'reparto' })),
}))
vi.mock('@/lib/puerta-de-entrada', () => ({
    CUERPO_NO_DISPONIBLE: { error: 'comprobacion_no_disponible' },
    ComprobacionNoDisponible: class extends Error {},
    comprobarEntrada: vi.fn(async () => true),
    entradasDe: vi.fn(() => []),
}))
vi.mock('@/lib/aplicaciones-visibles', () => ({ accesoDe: vi.fn(async () => ({})) }))
vi.mock('@/lib/flow-state', () => ({ getSessionCookieName: () => 'sesion' }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../exchange/route'

/** Devuelve de cada fila solo lo que el `select` pide, también dentro de `organization`. */
const respetandoSelect = (fila: Fila, select: Seleccion): Fila =>
    Object.fromEntries(
        Object.entries(select)
            .filter(([, v]) => v)
            .map(([k, v]) => [k, typeof v === 'object' ? respetandoSelect(fila[k] as Fila, (v as { select: Seleccion }).select) : fila[k]]),
    )

const canjear = async () =>
    (await ((await POST({ json: async () => ({ code: 'x'.repeat(40) }) } as never)) as Response).json())

beforeEach(() => {
    vi.clearAllMocks()
    betterAuth.getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } })
    filas.miembros = [
        { id: 'm1', role: 'GESTOR', createdAt: new Date('2026-01-01'), organization: { id: 'o1', name: 'Palma Soriano', slug: 'palma-soriano', logo: null, codigo: 'PLS' } },
        { id: 'm2', role: 'GESTOR', createdAt: new Date('2025-01-01'), organization: { id: 'o2', name: 'Holguín', slug: 'hol', logo: 'l.png', codigo: 'HOL' } },
        { id: 'm3', role: 'GESTOR', createdAt: new Date('2024-01-01'), organization: { id: 'o3', name: 'Sin código', slug: 'sin-codigo', logo: null, codigo: null } },
    ]
    db.member.findMany.mockImplementation(async (a: { select: Seleccion }) => filas.miembros.map((f) => respetandoSelect(f, a.select)))
    db.user.findUnique.mockResolvedValue({ defaultRole: { name: 'GESTOR' }, members: [] })
})

describe('exchange manda el código de la sucursal además del slug', () => {
    it('PLS: slug `palma-soriano` Y codigo `PLS`', async () => {
        const cuerpo = await canjear()
        const pls = cuerpo.memberships.find((m: { id: string }) => m.id === 'm1')
        expect(pls.organization.slug).toBe('palma-soriano')
        expect(pls.organization.codigo).toBe('PLS')
    })

    it('cada sucursal trae el suyo; una sin código sale con `codigo: null` (la clave siempre está)', async () => {
        const { memberships } = await canjear()
        expect(memberships.map((m: { organization: { codigo: string | null } }) => m.organization.codigo)).toEqual(['PLS', 'HOL', null])
    })

    it('es ADITIVO: la organización conserva id, name, slug y logo tal cual', async () => {
        const { memberships } = await canjear()
        expect(memberships[1].organization).toEqual({ id: 'o2', name: 'Holguín', slug: 'hol', logo: 'l.png', codigo: 'HOL' })
        expect(Object.keys(memberships[0]).sort()).toEqual(['createdAt', 'id', 'organization', 'roles'])
    })

    it('la consulta PIDE `codigo` (si se quita del select, no llega)', async () => {
        await canjear()
        expect(db.member.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    organization: { select: expect.objectContaining({ slug: true, codigo: true }) },
                }),
            }),
        )
    })
})
