/**
 * Los puntos de la API que cambian lo que una aplicación sabe de una persona AVISAN
 * (`lib/eventos-de-sesion.ts`), con el tipo y las personas correctas, y sólo DESPUÉS
 * de que la base lo hiciera. Los de better-auth están en `lib/__tests__/hooks-de-sesion.test.ts`
 * y los del panel en `(user)/dashboard/__tests__/avisos-a-las-aplicaciones.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.BEARER_TOKEN = 'servicio-de-pruebas'

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    session: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    member: {
        findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(),
        delete: vi.fn(), deleteMany: vi.fn(),
    },
    memberRole: { deleteMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    role: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
    permission: { findMany: vi.fn() },
    organization: { delete: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    invitation: { findFirst: vi.fn(), update: vi.fn() },
    refreshToken: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
}))
const avisos = vi.hoisted(() => ({
    publicarSesionCerrada: vi.fn(async () => {}),
    publicarPermisosCambiados: vi.fn(async () => {}),
    personasConRol: vi.fn(async () => ['p1', 'p2']),
    personasDeLaSucursal: vi.fn(async () => ['s1', 's2']),
}))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/eventos-de-sesion', () => avisos)
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/redis', () => ({
    getRedis: () => ({ pipeline: () => ({ set: vi.fn(), exec: vi.fn(async () => []) }) }),
}))
vi.mock('@/lib/with-service-auth', () => ({
    withServiceAuth: (h: (req: Request, ctx: unknown) => unknown) => (req: Request) => h(req, { client: { clientId: 'c' } }),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/rbac/resolve-permissions', () => ({ resolveRbac: vi.fn(async () => ({})) }))
vi.mock('@/rbac/en-sucursal', () => ({ rbacEnSucursal: vi.fn(async () => ({})), rolesEnSucursal: vi.fn(async () => []) }))
vi.mock('@/rbac/can', () => ({ can: () => true }))
vi.mock('@/rbac/grantable', () => ({ ungrantablePermissionKeys: () => [] }))
vi.mock('@/rbac/escalafon', () => ({ puedeRepartirRol: () => true }))

import { POST as revocarSesion } from '../auth/revoke-session/route'
import { PATCH as patchRol, DELETE as deleteRol } from '../rbac/roles/[roleId]/route'
import { PUT as ponerRoles } from '../rbac/orgs/[orgId]/members/[memberId]/roles/route'
import { DELETE as quitarMiembroRbac } from '../rbac/orgs/[orgId]/members/route'
import { DELETE as quitarMiembro } from '../organizations/[orgId]/members/[memberId]/route'
import { DELETE as borrarSucursal, PATCH as editarSucursal } from '../organizations/[orgId]/route'
import { POST as altaDeMiembro } from '../organizations/[orgId]/members/route'
import { PATCH as cambiarRolDeMiembro } from '../organizations/[orgId]/members/[memberId]/route'
import { POST as aceptarInvitacion } from '../invitations/accept/route'
import { cerrarSesionDelAparato, revocarTodasLasSesiones } from '@/lib/apk-tokens'

const SERVICIO = { authorization: 'Bearer servicio-de-pruebas', 'x-acting-user-id': 'actor-1' }
const pet = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Request(`http://auth.test${url}`, {
        method: init.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

beforeEach(() => {
    vi.resetAllMocks()
    avisos.personasConRol.mockResolvedValue(['p1', 'p2'])
    avisos.personasDeLaSucursal.mockResolvedValue(['s1', 's2'])
    db.$transaction.mockImplementation(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => unknown)(db) : Promise.all(arg as unknown[]),
    )
    db.user.findUnique.mockResolvedValue({ id: 'actor-1', isSystemAdmin: true })
    db.permission.findMany.mockResolvedValue([])
    db.memberRole.findMany.mockResolvedValue([])
})

const nadieAvisado = () => {
    expect(avisos.publicarSesionCerrada).not.toHaveBeenCalled()
    expect(avisos.publicarPermisosCambiados).not.toHaveBeenCalled()
}

describe('POST /api/auth/revoke-session → sesion-cerrada «revocada»', () => {
    it('por sessionId: avisa a la persona dueña de ESA sesión', async () => {
        db.session.update.mockResolvedValue({ id: 's1', userId: 'u7' })
        const res = await revocarSesion(pet('/api/auth/revoke-session', { body: { sessionId: 's1' } }) as never)
        expect(res.status).toBe(200)
        expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u7'], 'revocada')
    })
    it('por userId: avisa a esa persona', async () => {
        db.session.updateMany.mockResolvedValue({ count: 3 })
        db.session.findMany.mockResolvedValue([{ id: 'a' }])
        await revocarSesion(pet('/api/auth/revoke-session', { body: { userId: 'u8' } }) as never)
        expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u8'], 'revocada')
    })
    it('por userId de una persona que NO existe: 404 y no revoca ni avisa (B3)', async () => {
        db.user.findUnique.mockResolvedValue(null)
        const res = await revocarSesion(pet('/api/auth/revoke-session', { body: { userId: 'inventado' } }) as never)
        expect(res.status).toBe(404)
        expect(db.session.updateMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it.each([
        ['userId de 1 MB', { userId: 'x'.repeat(1_000_000) }],
        ['userId de 129 caracteres', { userId: 'x'.repeat(129) }],
        ['userId vacío', { userId: '' }],
        ['sessionId de 129 caracteres', { sessionId: 'x'.repeat(129) }],
    ])('cuerpo con %s: 400 y no toca la base ni avisa (B3)', async (_n, body) => {
        const res = await revocarSesion(pet('/api/auth/revoke-session', { body }) as never)
        expect(res.status).toBe(400)
        expect(db.user.findUnique).not.toHaveBeenCalled()
        expect(db.session.updateMany).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('un userId de 128 caracteres (el tope) vale', async () => {
        db.session.updateMany.mockResolvedValue({ count: 0 })
        db.session.findMany.mockResolvedValue([])
        const res = await revocarSesion(pet('/api/auth/revoke-session', { body: { userId: 'x'.repeat(128) } }) as never)
        expect(res.status).toBe(200)
    })
    it('sesión que no existe, o cuerpo inválido: no avisa', async () => {
        db.session.update.mockRejectedValue(new Error('P2025'))
        await revocarSesion(pet('/api/auth/revoke-session', { body: { sessionId: 'nada' } }) as never)
        await revocarSesion(pet('/api/auth/revoke-session', { body: {} }) as never)
        nadieAvisado()
    })
    it('la base falla: no avisa', async () => {
        db.session.updateMany.mockRejectedValue(new Error('db'))
        await expect(
            revocarSesion(pet('/api/auth/revoke-session', { body: { userId: 'u8' } }) as never),
        ).rejects.toThrow()
        nadieAvisado()
    })
})

describe('apk-tokens → sesion-cerrada', () => {
    it('cerrar sesión desde el aparato NO avisa a nadie: la web es la web y la APK es la APK', async () => {
        db.refreshToken.findUnique.mockResolvedValue({ id: 'rt', userId: 'u1', familyId: 'f1' })
        db.refreshToken.findFirst.mockResolvedValue({ sessionId: null })
        await cerrarSesionDelAparato('cualquiera')
        nadieAvisado()
    })
    it('refresh desconocido: no avisa', async () => {
        db.refreshToken.findUnique.mockResolvedValue(null)
        await cerrarSesionDelAparato('inventado')
        nadieAvisado()
    })
    it('si la base falla al cerrar la cadena: no avisa', async () => {
        db.refreshToken.findUnique.mockResolvedValue({ id: 'rt', userId: 'u1', familyId: 'f1' })
        db.refreshToken.findFirst.mockRejectedValue(new Error('db'))
        await expect(cerrarSesionDelAparato('x')).rejects.toThrow()
        nadieAvisado()
    })
    it('revocar todas las sesiones de la cuenta (refresh robado): «revocada»', async () => {
        await revocarTodasLasSesiones('u1', 'refresh reutilizado')
        expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u1'], 'revocada')
    })
    it('revocarTodasLasSesiones con la base caída: no avisa', async () => {
        db.refreshToken.updateMany.mockRejectedValue(new Error('db'))
        await expect(revocarTodasLasSesiones('u1', 'x')).rejects.toThrow()
        nadieAvisado()
    })
})

describe('permisos de un ROL', () => {
    const params = { params: Promise.resolve({ roleId: 'r1' }) }
    const llaves = (...ks: string[]) => ks.map((k) => ({ permission: { key: k } }))
    /** Las llaves que existen en el catálogo (lo que `permission.findMany` encuentra para las pedidas). */
    const catalogo = (...ks: string[]) => db.permission.findMany.mockResolvedValue(ks.map((key, i) => ({ id: `p${i}`, key })))
    beforeEach(() => {
        db.role.findUnique.mockResolvedValue({
            id: 'r1', name: 'GESTOR', isSystem: false, _count: { memberRoles: 0 }, permissions: llaves('a.b', 'c.d'),
        })
    })

    it('PATCH que QUITA una llave → permisos-cambiados «llaves» a TODOS los que tienen el rol', async () => {
        catalogo('a.b')
        const res = await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b'] } }), params)
        expect(res.status).toBe(200)
        expect(avisos.personasConRol).toHaveBeenCalledWith('r1')
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'llaves')
    })
    it('PATCH que guarda EXACTAMENTE las mismas llaves → no avisa', async () => {
        catalogo('c.d', 'a.b')
        const res = await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b', 'c.d'] } }), params)
        expect(res.status).toBe(200)
        expect(db.rolePermission.createMany).toHaveBeenCalled()
        nadieAvisado()
    })
    it('PATCH que sólo AÑADE una llave → no avisa', async () => {
        catalogo('a.b', 'c.d', 'e.f')
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b', 'c.d', 'e.f'] } }), params)
        nadieAvisado()
    })
    it('PATCH que cambia una llave por otra → avisa (la vieja se pierde)', async () => {
        catalogo('a.b', 'e.f')
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b', 'e.f'] } }), params)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'llaves')
    })
    it('PATCH con una llave que NO existe en el catálogo cuenta como quitada', async () => {
        catalogo('a.b') // c.d ya no sale del catálogo
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b', 'c.d'] } }), params)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'llaves')
    })
    it('PATCH que sólo renombra el rol → «rol»', async () => {
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { name: 'OTRO' } }), params)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'rol')
    })
    it('PATCH que repite las llaves y además renombra → «rol» (el nombre cuenta)', async () => {
        catalogo('a.b', 'c.d')
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { name: 'OTRO', permissionKeys: ['a.b', 'c.d'] } }), params)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'rol')
    })
    it('PATCH que sólo cambia el color → no avisa', async () => {
        await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { color: 'red' } }), params)
        nadieAvisado()
    })
    it('PATCH que falla en la base → no avisa', async () => {
        catalogo('a.b')
        db.$transaction.mockRejectedValue(new Error('db'))
        await expect(
            patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: ['a.b'] } }), params),
        ).rejects.toThrow()
        nadieAvisado()
    })
    it('PATCH rechazado (rol inexistente) → no avisa', async () => {
        db.role.findUnique.mockResolvedValue(null)
        const res = await patchRol(pet('/x', { method: 'PATCH', headers: SERVICIO, body: { permissionKeys: [] } }), params)
        expect(res.status).toBe(404)
        nadieAvisado()
    })
    it('DELETE → «rol» a quienes lo tenían por defecto, apuntados ANTES de borrar', async () => {
        const orden: string[] = []
        avisos.personasConRol.mockImplementation(async () => { orden.push('leer'); return ['p1'] })
        db.role.delete.mockImplementation(async () => { orden.push('borrar') })
        avisos.publicarPermisosCambiados.mockImplementation(async () => { orden.push('avisar') })
        const res = await deleteRol(pet('/x', { method: 'DELETE', headers: SERVICIO }), params)
        expect(res.status).toBe(200)
        expect(orden).toEqual(['leer', 'borrar', 'avisar'])
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1'], 'rol')
    })
    it('DELETE: si no se puede saber quién lo tiene (la base falla) el borrado ABORTA, no borra sin avisar', async () => {
        avisos.personasConRol.mockRejectedValue(new Error('db'))
        await expect(deleteRol(pet('/x', { method: 'DELETE', headers: SERVICIO }), params)).rejects.toThrow('db')
        expect(avisos.personasConRol).toHaveBeenCalledWith('r1', { lanzar: true })
        expect(db.role.delete).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('DELETE de un rol del sistema o con miembros → no avisa', async () => {
        db.role.findUnique.mockResolvedValue({ id: 'r1', isSystem: true, _count: { memberRoles: 0 } })
        await deleteRol(pet('/x', { method: 'DELETE', headers: SERVICIO }), params)
        db.role.findUnique.mockResolvedValue({ id: 'r1', isSystem: false, _count: { memberRoles: 2 } })
        await deleteRol(pet('/x', { method: 'DELETE', headers: SERVICIO }), params)
        nadieAvisado()
    })
})

describe('membresías y roles de una persona', () => {
    it('PUT roles que QUITA un rol → «rol» de la persona del miembro', async () => {
        db.member.findUnique.mockResolvedValue({ organizationId: 'org1', userId: 'u5' })
        db.memberRole.findMany.mockResolvedValue([{ roleId: 'vieja' }])
        db.role.findMany.mockResolvedValue([])
        const res = await ponerRoles(pet('/x', { method: 'PUT', headers: SERVICIO, body: { roleIds: [] } }), {
            params: Promise.resolve({ orgId: 'org1', memberId: 'm1' }),
        })
        expect(res.status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u5'], 'rol')
    })
    it('PUT roles que sólo AÑADE (o repite) roles → no avisa', async () => {
        db.member.findUnique.mockResolvedValue({ organizationId: 'org1', userId: 'u5' })
        db.memberRole.findMany.mockResolvedValue([{ roleId: 'r1' }])
        db.role.findMany.mockResolvedValue([{ id: 'r1', name: 'GESTOR', permissions: [] }, { id: 'r2', name: 'OPERADOR', permissions: [] }])
        const p = { params: Promise.resolve({ orgId: 'org1', memberId: 'm1' }) }
        expect((await ponerRoles(pet('/x', { method: 'PUT', headers: SERVICIO, body: { roleIds: ['r1', 'r2'] } }), p)).status).toBe(200)
        expect((await ponerRoles(pet('/x', { method: 'PUT', headers: SERVICIO, body: { roleIds: ['r1'] } }), p)).status).toBe(200)
        expect(db.memberRole.create).toHaveBeenCalled()
        nadieAvisado()
    })
    it('PUT de un miembro de OTRA sucursal (404) → no avisa', async () => {
        db.member.findUnique.mockResolvedValue({ organizationId: 'otra', userId: 'u5' })
        const res = await ponerRoles(pet('/x', { method: 'PUT', headers: SERVICIO, body: { roleIds: [] } }), {
            params: Promise.resolve({ orgId: 'org1', memberId: 'm1' }),
        })
        expect(res.status).toBe(404)
        nadieAvisado()
    })

    it('DELETE de un miembro (rbac) → «membresia» de su persona', async () => {
        db.member.findFirst.mockResolvedValue({ userId: 'u5' })
        db.member.deleteMany.mockResolvedValue({ count: 1 })
        const res = await quitarMiembroRbac(pet('/x?memberId=m1', { method: 'DELETE', headers: SERVICIO }), {
            params: Promise.resolve({ orgId: 'org1' }),
        })
        expect(res.status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u5'], 'membresia')
    })
    it('DELETE de un miembro que no existe → 404 y no avisa', async () => {
        db.member.findFirst.mockResolvedValue(null)
        db.member.deleteMany.mockResolvedValue({ count: 0 })
        const res = await quitarMiembroRbac(pet('/x?memberId=m1', { method: 'DELETE', headers: SERVICIO }), {
            params: Promise.resolve({ orgId: 'org1' }),
        })
        expect(res.status).toBe(404)
        nadieAvisado()
    })

    it('DELETE /organizations/:org/members/:id → «membresia» de la persona quitada', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } })
        db.member.findUnique.mockImplementation(async (a: { where: { id?: string } }) =>
            a.where.id === 'm9'
                ? { id: 'm9', userId: 'u9', organizationId: 'org1', role: 'agent' }
                : { id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'owner' },
        )
        const res = await quitarMiembro(pet('/x', { method: 'DELETE' }), {
            params: Promise.resolve({ orgId: 'org1', memberId: 'm9' }),
        })
        expect(res.status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u9'], 'membresia')
    })
    it('DELETE sin permiso (403) → no avisa', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } })
        db.member.findUnique.mockImplementation(async (a: { where: { id?: string } }) =>
            a.where.id === 'm9'
                ? { id: 'm9', userId: 'u9', organizationId: 'org1', role: 'agent' }
                : { id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'agent' },
        )
        const res = await quitarMiembro(pet('/x', { method: 'DELETE' }), {
            params: Promise.resolve({ orgId: 'org1', memberId: 'm9' }),
        })
        expect(res.status).toBe(403)
        nadieAvisado()
    })

    it('DELETE de una sucursal → «membresia» de quienes eran de ella (apuntados ANTES)', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } })
        db.member.findUnique.mockResolvedValue({ id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'owner' })
        const orden: string[] = []
        avisos.personasDeLaSucursal.mockImplementation(async () => { orden.push('leer'); return ['s1'] })
        db.organization.delete.mockImplementation(async () => { orden.push('borrar') })
        avisos.publicarPermisosCambiados.mockImplementation(async () => { orden.push('avisar') })
        const res = await borrarSucursal(pet('/x', { method: 'DELETE' }), { params: Promise.resolve({ orgId: 'org1' }) })
        expect(res.status).toBe(200)
        expect(orden).toEqual(['leer', 'borrar', 'avisar'])
    })
    it('DELETE de una sucursal: si no se puede saber quiénes eran, ABORTA (500) y no borra sin avisar', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } })
        db.member.findUnique.mockResolvedValue({ id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'owner' })
        avisos.personasDeLaSucursal.mockRejectedValue(new Error('db'))
        const res = await borrarSucursal(pet('/x', { method: 'DELETE' }), { params: Promise.resolve({ orgId: 'org1' }) })
        expect(res.status).toBe(500)
        expect(avisos.personasDeLaSucursal).toHaveBeenCalledWith('org1', { lanzar: true })
        expect(db.organization.delete).not.toHaveBeenCalled()
        nadieAvisado()
    })
    it('DELETE de una sucursal que no es owner (403) → no avisa', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } })
        db.member.findUnique.mockResolvedValue({ id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'agent' })
        const res = await borrarSucursal(pet('/x', { method: 'DELETE' }), { params: Promise.resolve({ orgId: 'org1' }) })
        expect(res.status).toBe(403)
        nadieAvisado()
    })

    it('aceptar una invitación → entra y NO avisa (un alta sólo da acceso)', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'u3', email: 'a@b.c' } })
        db.invitation.findFirst.mockResolvedValue({
            id: 'i1', status: 'pending', expiresAt: new Date(Date.now() + 1e6), email: 'a@b.c',
            organizationId: 'org1', role: 'agent', roleId: null, organization: { name: 'CAM' },
        })
        db.member.findUnique.mockResolvedValue(null)
        db.member.create.mockResolvedValue({ id: 'm1' })
        db.invitation.update.mockResolvedValue({})
        const res = await aceptarInvitacion(pet('/x', { body: { token: 't' } }))
        expect(res.status).toBe(200)
        expect(db.member.create).toHaveBeenCalled()
        nadieAvisado()
    })
    it('invitación caducada o de otro correo → no avisa', async () => {
        betterAuth.getSession.mockResolvedValue({ user: { id: 'u3', email: 'a@b.c' } })
        db.invitation.findFirst.mockResolvedValue({
            id: 'i1', status: 'pending', expiresAt: new Date(Date.now() + 1e6), email: 'otro@b.c',
            organizationId: 'org1', role: 'agent', organization: {},
        })
        const res = await aceptarInvitacion(pet('/x', { body: { token: 't' } }))
        expect(res.status).toBe(403)
        nadieAvisado()
    })
})

describe('/api/organizations/:org/members: dar acceso NO publica; quitárselo o bajarle el rango, sí', () => {
    const p = (memberId = 'm0') => ({ params: Promise.resolve({ orgId: 'org1', memberId }) })
    beforeEach(() => betterAuth.getSession.mockResolvedValue({ user: { id: 'yo' } }))
    /** `yo` es `rolMio` en org1; `m9` (de u9) es `rolSuyo`. */
    const mundo = (rolMio: string, rolSuyo = 'agent') =>
        db.member.findUnique.mockImplementation(async (a: { where: { id?: string; userId_organizationId?: unknown } }) =>
            a.where.id === 'm9'
                ? { id: 'm9', userId: 'u9', organizationId: 'org1', role: rolSuyo }
                : { id: 'm-yo', userId: 'yo', organizationId: 'org1', role: rolMio },
        )

    it('POST (alta por correo) → 201 y NO avisa: era el vector para echar a cualquiera de todas las apps', async () => {
        db.member.findUnique.mockImplementation(async (a: { where: { userId_organizationId?: { userId: string } } }) =>
            a.where.userId_organizationId?.userId === 'yo' ? { id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'owner' } : null,
        )
        db.user.findUnique.mockResolvedValue({ id: 'victima' })
        db.member.create.mockResolvedValue({ id: 'm-nuevo', userId: 'victima' })
        const res = await altaDeMiembro(pet('/x', { body: { email: 'victima@x.y' } }), p())
        expect(res.status).toBe(201)
        expect(db.member.create).toHaveBeenCalled()
        nadieAvisado()
    })
    it('POST sin ser owner/admin de ESA organización → 403 y no crea ni avisa', async () => {
        db.member.findUnique.mockResolvedValue(null) // yo no estoy en org1
        const res = await altaDeMiembro(pet('/x', { body: { email: 'victima@x.y' } }), p())
        expect(res.status).toBe(403)
        expect(db.member.create).not.toHaveBeenCalled()
        nadieAvisado()
    })

    it('PATCH que ASCIENDE (agent → admin) → no avisa', async () => {
        mundo('owner', 'agent')
        db.member.update.mockResolvedValue({ userId: 'u9' })
        const res = await cambiarRolDeMiembro(pet('/x', { method: 'PATCH', body: { role: 'admin' } }), p('m9'))
        expect(res.status).toBe(200)
        nadieAvisado()
    })
    it('PATCH que BAJA (staff → agent) → «rol» de esa persona', async () => {
        mundo('owner', 'staff')
        db.member.update.mockResolvedValue({ userId: 'u9' })
        await cambiarRolDeMiembro(pet('/x', { method: 'PATCH', body: { role: 'agent' } }), p('m9'))
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u9'], 'rol')
    })
    it('PATCH que deja el mismo rol → no avisa', async () => {
        mundo('owner', 'staff')
        db.member.update.mockResolvedValue({ userId: 'u9' })
        await cambiarRolDeMiembro(pet('/x', { method: 'PATCH', body: { role: 'staff' } }), p('m9'))
        nadieAvisado()
    })
    it('PATCH traspaso de propiedad → avisa SÓLO al dueño que baja a admin, no al que la recibe', async () => {
        mundo('owner', 'admin')
        db.$transaction.mockImplementation(async (arg: unknown) => Promise.all(arg as unknown[]))
        db.member.update.mockResolvedValue({})
        const res = await cambiarRolDeMiembro(pet('/x', { method: 'PATCH', body: { role: 'owner' } }), p('m9'))
        expect(res.status).toBe(200)
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['yo'], 'rol')
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledTimes(1)
    })
    it('PATCH sin permiso (agent) → 403 y no avisa', async () => {
        mundo('agent', 'agent')
        const res = await cambiarRolDeMiembro(pet('/x', { method: 'PATCH', body: { role: 'staff' } }), p('m9'))
        expect(res.status).toBe(403)
        nadieAvisado()
    })
    it('DELETE de un miembro de OTRA organización (id de otra sucursal en la URL) → 404 y no avisa', async () => {
        db.member.findUnique.mockImplementation(async (a: { where: { id?: string } }) =>
            a.where.id === 'm-otra'
                ? { id: 'm-otra', userId: 'u9', organizationId: 'org-ajena', role: 'agent' }
                : { id: 'm-yo', userId: 'yo', organizationId: 'org1', role: 'owner' },
        )
        const res = await quitarMiembro(pet('/x', { method: 'DELETE' }), { params: Promise.resolve({ orgId: 'org1', memberId: 'm-otra' }) })
        expect(res.status).toBe(404)
        expect(db.member.delete).not.toHaveBeenCalled()
        nadieAvisado()
    })
})

describe('PATCH /api/organizations/:org (A2): sólo avisa si DE VERDAD se desactiva o cambia el código', () => {
    const p = { params: Promise.resolve({ orgId: 'org1' }) }
    const guardar = (body: Record<string, unknown>) => editarSucursal(pet('/x', { method: 'PATCH', headers: SERVICIO, body }), p)
    beforeEach(() => {
        db.organization.findUnique.mockResolvedValue({ activa: true, codigo: 'CAM' })
        db.organization.findFirst.mockResolvedValue(null)
        // La base devuelve la fila ya guardada.
        db.organization.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
            id: 'org1', activa: true, codigo: 'CAM', ...a.data,
        }))
    })

    it('guardar SIN cambios (manda codigo y activa tal cual están) → 200 y no avisa', async () => {
        const res = await guardar({ name: 'Camagüey', codigo: 'CAM', activa: true, telefono: '555' })
        expect(res.status).toBe(200)
        expect(db.organization.update).toHaveBeenCalled()
        nadieAvisado()
    })
    it('DESACTIVAR → avisa a TODA la sucursal', async () => {
        await guardar({ codigo: 'CAM', activa: false })
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['s1', 's2'], 'membresia')
    })
    it('cambiar el CÓDIGO → avisa', async () => {
        await guardar({ codigo: 'cmg', activa: true })
        expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['s1', 's2'], 'membresia')
    })
    it('REACTIVAR → no avisa', async () => {
        db.organization.findUnique.mockResolvedValue({ activa: false, codigo: 'CAM' })
        await guardar({ activa: true })
        nadieAvisado()
    })
    it('sólo el teléfono → no avisa', async () => {
        await guardar({ telefono: '123' })
        nadieAvisado()
    })
})
