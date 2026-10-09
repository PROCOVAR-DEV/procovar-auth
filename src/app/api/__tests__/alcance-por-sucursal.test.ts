/**
 * A1(3) de la auditoría 08/10/2026: quien NO es administrador de sistema sólo actúa sobre las
 * membresías de las sucursales de las que ES miembro. Aquí el RBAC es el REAL (`resolveRbac`,
 * `rbacEnSucursal`, `can`) sobre una base simulada: un ADMINISTRADOR de Camagüey (A) con
 * `member.remove` en su rol intenta quitar, listar y avisar a gente de Holguín (B) cambiando el id
 * de la URL o de la acción. Nada se borra y NADIE recibe aviso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    member: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn() },
    memberRole: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn() },
    role: { findUnique: vi.fn(), findMany: vi.fn() },
    organization: { findUnique: vi.fn() },
    $transaction: vi.fn(),
}))
const avisos = vi.hoisted(() => ({
    publicarSesionCerrada: vi.fn(async () => {}),
    publicarPermisosCambiados: vi.fn(async () => {}),
    personasConRol: vi.fn(async () => []),
    personasDeLaSucursal: vi.fn(async () => []),
}))
const sesion = vi.hoisted(() => ({ getCurrentUser: vi.fn() }))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))
const alta = vi.hoisted(() => ({ altaPersona: vi.fn(), esSuperAdmin: vi.fn(() => false) }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/eventos-de-sesion', () => avisos)
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/server/auth.server', () => sesion)
vi.mock('@/lib/alta-persona', () => alta)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/redis', () => ({ getRedis: () => ({}) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('better-auth/crypto', () => ({ hashPassword: vi.fn(async () => 'hash') }))

import { DELETE as quitarRbac, GET as listarRbac } from '../rbac/orgs/[orgId]/members/route'
import { GET as buscarPersona } from '../rbac/orgs/[orgId]/user-search/route'
import { PUT as ponerRoles } from '../rbac/orgs/[orgId]/members/[memberId]/roles/route'
import { removeOrgMember, setOrgMemberRoles, agregarMiembro, anadirPersona } from '@/app/(user)/dashboard/_actions'

const LLAVES = ['member.read', 'member.remove', 'member.invite', 'member.assignRole'].map((key) => ({ permission: { key } }))
const ADMIN_DE_A = {
    id: 'admin-a', isSystemAdmin: false, defaultRole: { name: 'ADMINISTRADOR', permissions: LLAVES },
}
const SUPER = { id: 'super', isSystemAdmin: true, defaultRole: null }
const SIN_ROL = { id: 'nadie', isSystemAdmin: false, defaultRole: null }

/** Quién es `yo` en la base simulada: miembro sólo de la sucursal A. */
function mundo(yo: typeof ADMIN_DE_A | typeof SUPER | typeof SIN_ROL) {
    betterAuth.getSession.mockResolvedValue({ user: { id: yo.id, isSystemAdmin: yo.isSystemAdmin } })
    sesion.getCurrentUser.mockResolvedValue({ data: { id: yo.id, isSystemAdmin: yo.isSystemAdmin } })
    db.user.findUnique.mockImplementation(async (a: { where: { id: string } }) => (a.where.id === yo.id ? yo : { id: a.where.id, isSystemAdmin: false, defaultRole: null }))
    db.member.findUnique.mockImplementation(async (a: { where: { id?: string; userId_organizationId?: { userId: string; organizationId: string } } }) => {
        if (a.where.id === 'm-b') return { id: 'm-b', userId: 'u-b', organizationId: 'B', role: 'GESTOR', memberRoles: [], user: { email: 'b@x.y' }, organization: { name: 'Holguín' } }
        if (a.where.id === 'm-a') return { id: 'm-a', userId: 'u-a', organizationId: 'A', role: 'GESTOR', memberRoles: [], user: { email: 'a@x.y' }, organization: { name: 'Camagüey' } }
        const k = a.where.userId_organizationId
        if (k && k.userId === yo.id && k.organizationId === 'A') return { id: 'm-yo', memberRoles: [] }
        return null
    })
    db.member.findFirst.mockImplementation(async (a: { where: { id: string; organizationId: string } }) =>
        a.where.id === 'm-b' && a.where.organizationId === 'B' ? { userId: 'u-b' } : a.where.id === 'm-a' && a.where.organizationId === 'A' ? { userId: 'u-a' } : null,
    )
    db.member.deleteMany.mockImplementation(async (a: { where: { id: string; organizationId: string } }) => ({
        count: (a.where.id === 'm-b' && a.where.organizationId === 'B') || (a.where.id === 'm-a' && a.where.organizationId === 'A') ? 1 : 0,
    }))
}

const pet = (url: string, init: RequestInit = {}) => new Request(`http://auth.test${url}`, init)
const nadieAvisado = () => {
    expect(avisos.publicarPermisosCambiados).not.toHaveBeenCalled()
    expect(avisos.publicarSesionCerrada).not.toHaveBeenCalled()
}

beforeEach(() => {
    vi.resetAllMocks()
    alta.esSuperAdmin.mockReturnValue(false)
    db.$transaction.mockImplementation(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => unknown)(db) : Promise.all(arg as unknown[]),
    )
    db.member.findMany.mockResolvedValue([])
    db.user.findMany.mockResolvedValue([])
    db.memberRole.findMany.mockResolvedValue([])
    db.role.findMany.mockResolvedValue([])
})

describe('API /api/rbac/orgs/:org/members', () => {
    const enB = { params: Promise.resolve({ orgId: 'B' }) }
    const enA = { params: Promise.resolve({ orgId: 'A' }) }

    it('el ADMINISTRADOR de A NO quita a nadie de B: 403, nada borrado, nadie avisado', async () => {
        mundo(ADMIN_DE_A)
        const res = await quitarRbac(pet('/x?memberId=m-b', { method: 'DELETE' }), enB)
        expect(res.status).toBe(403)
        expect(db.member.deleteMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('el mismo ADMINISTRADOR SÍ quita a alguien de SU sucursal, y se avisa a esa persona', async () => {
        mundo(ADMIN_DE_A)
        const res = await quitarRbac(pet('/x?memberId=m-a', { method: 'DELETE' }), enA)
        expect(res.status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u-a'], 'membresia')
    })
    it('el ADMINISTRADOR de A no LISTA los miembros de B ni busca personas desde B', async () => {
        mundo(ADMIN_DE_A)
        expect((await listarRbac(pet('/x'), enB)).status).toBe(403)
        expect((await buscarPersona(pet('/x?q=ana'), enB)).status).toBe(403)
        expect(db.member.findMany).not.toHaveBeenCalled()
        expect(db.user.findMany).not.toHaveBeenCalled()
        expect((await listarRbac(pet('/x'), enA)).status).toBe(200)
    })
    it('una persona sin rol ni sucursal no puede nada en ninguna', async () => {
        mundo(SIN_ROL)
        expect((await quitarRbac(pet('/x?memberId=m-a', { method: 'DELETE' }), enA)).status).toBe(403)
        expect((await quitarRbac(pet('/x?memberId=m-b', { method: 'DELETE' }), enB)).status).toBe(403)
        expect(db.member.deleteMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('el Super Admin sí actúa en cualquier sucursal', async () => {
        mundo(SUPER)
        expect((await quitarRbac(pet('/x?memberId=m-b', { method: 'DELETE' }), enB)).status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u-b'], 'membresia')
    })
    it('un miembro de B cuyo id se manda con la URL de A (IDOR) → 404, nada avisado', async () => {
        mundo(ADMIN_DE_A)
        const res = await quitarRbac(pet('/x?memberId=m-b', { method: 'DELETE' }), enA)
        expect(res.status).toBe(404)
        nadieAvisado()
    })
    it('PUT de roles sobre un miembro de B por el ADMINISTRADOR de A → 403, nada cambia', async () => {
        mundo(ADMIN_DE_A)
        const res = await ponerRoles(pet('/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleIds: [] }) }), {
            params: Promise.resolve({ orgId: 'B', memberId: 'm-b' }),
        })
        expect(res.status).toBe(403)
        expect(db.memberRole.deleteMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
})

describe('acciones del panel (_actions.ts)', () => {
    it('removeOrgMember de un miembro de B por el ADMINISTRADOR de A → error, nada borrado, nadie avisado', async () => {
        mundo(ADMIN_DE_A)
        const res = await removeOrgMember('m-b')
        expect(res.error).toMatch(/sucursal/i)
        expect(db.member.delete).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('removeOrgMember en SU sucursal sí, y avisa', async () => {
        mundo(ADMIN_DE_A)
        const res = await removeOrgMember('m-a')
        expect(res.error).toBeUndefined()
        expect(db.member.delete).toHaveBeenCalled()
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u-a'], 'membresia')
    })
    it('setOrgMemberRoles sobre un miembro de B → error, nada cambia', async () => {
        mundo(ADMIN_DE_A)
        const res = await setOrgMemberRoles('m-b', [])
        expect(res.error).toMatch(/sucursal/i)
        expect(db.memberRole.deleteMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('agregarMiembro y anadirPersona en B → error, nada creado, nadie avisado', async () => {
        mundo(ADMIN_DE_A)
        expect((await agregarMiembro({ organizationId: 'B', userId: 'victima', roleId: 'r1' })).error).toMatch(/sucursal/i)
        expect((await anadirPersona({ organizationId: 'B', nombre: 'X', password: 'una-clave-larga', roleId: 'r1' })).error).toMatch(/sucursal/i)
        expect(db.member.create).not.toHaveBeenCalled()
        expect(alta.altaPersona).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('una persona sin rol no hace nada ni en la acción más inofensiva', async () => {
        mundo(SIN_ROL)
        expect((await removeOrgMember('m-a')).error).toBeTruthy()
        expect((await agregarMiembro({ organizationId: 'A', userId: 'victima', roleId: 'r1' })).error).toBeTruthy()
        nadieAvisado()
    })
})
