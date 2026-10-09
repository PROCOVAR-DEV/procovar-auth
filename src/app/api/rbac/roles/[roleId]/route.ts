import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { resolveRbac } from '@/rbac/resolve-permissions'
import { can } from '@/rbac/can'
import { ungrantablePermissionKeys } from '@/rbac/grantable'
import { personasConRol, publicarPermisosCambiados } from '@/lib/eventos-de-sesion'
import { pierdeLlaves } from '@/lib/pierde-acceso'

type Params = { params: Promise<{ roleId: string }> }

type Actor = { id: string; isSystemAdmin: boolean }

function isServiceAuth(request: Request): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  const token = m?.[1]
  const expected = (process.env.BEARER_TOKEN) || ''
  return !!token && !!expected && token === expected
}

/**
 * Resolve the acting user. Two paths:
 *  - Browser session cookie → the logged-in user.
 *  - Service auth (BEARER_TOKEN, used by qb-panel) → the user named in the
 *    `x-acting-user-id` header. qb-auth re-loads that user so the system-role
 *    guard and permission checks are enforced server-side (defense in depth),
 *    not delegated entirely to the trusted caller.
 */
async function actor(request: Request): Promise<Actor | null> {
  if (isServiceAuth(request)) {
    const actingUserId = request.headers.get('x-acting-user-id')
    if (!actingUserId) return null
    const u = await prisma.user.findUnique({
      where: { id: actingUserId }, select: { id: true, isSystemAdmin: true },
    })
    return u ?? null
  }
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ? { id: session.user.id, isSystemAdmin: session.user.isSystemAdmin } : null
}

export async function PATCH(request: Request, { params }: Params) {
  const { roleId } = await params
  const user = await actor(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { permissions: { select: { permission: { select: { key: true } } } } },
  })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })

  // The role catalog is shared by all eight sucursales, so editing "Operador"
  // changes what every Operador in Procovar can do. Resolving with `null` gives
  // a wildcard to a Super Admin and nothing to anyone else — which is the rule
  // we want: an Administrador of Camagüey must not be able to widen a role that
  // is also in use in Holguín. They assign roles; they do not redefine them.
  const actorRbac = await resolveRbac(user.id, null)
  if (!can(actorRbac, 'role.edit')) {
    return NextResponse.json(
      { error: 'Solo un Super Admin puede cambiar los permisos de un rol: el catálogo es de toda Procovar' },
      { status: 403 },
    )
  }

  const { name, description, color, icon, permissionKeys } = await request.json()
  // Privilege-escalation guard: you may only set permissions on a role that you
  // yourself hold (systemadmin/wildcard grants anything). Only enforced when the
  // request actually replaces the permission set.
  if (Array.isArray(permissionKeys)) {
    const missing = ungrantablePermissionKeys(actorRbac, permissionKeys)
    if (missing.length) {
      return NextResponse.json({ error: 'cannot grant permissions you do not hold' }, { status: 403 })
    }
  }
  let llavesNuevas: string[] | null = null
  await prisma.$transaction(async (tx) => {
    await tx.role.update({
      where: { id: roleId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
      },
    })
    if (Array.isArray(permissionKeys)) {
      const perms = await tx.permission.findMany({
        where: { key: { in: permissionKeys }, isDeprecated: false }, select: { id: true, key: true },
      })
      llavesNuevas = perms.map((p) => p.key)
      await tx.rolePermission.deleteMany({ where: { roleId } })
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id })), skipDuplicates: true,
      })
    }
  })
  // El nombre del rol también cuenta: hay aplicaciones (Reparto) que deciden por él.
  const cambioElNombre = typeof name === 'string' && name !== role.name
  // Sólo se avisa si el rol PIERDE alguna llave (guardar lo mismo, o añadir, no quita nada a nadie) o si
  // cambia de nombre. Un PATCH que repite las llaves no puede echar a todos los que llevan el rol.
  const teniaLlaves = (role.permissions ?? []).map((p) => p.permission?.key).filter((k): k is string => Boolean(k))
  const quitaLlaves = llavesNuevas !== null && pierdeLlaves(teniaLlaves, llavesNuevas)
  if (quitaLlaves || cambioElNombre) {
    await publicarPermisosCambiados(await personasConRol(roleId), quitaLlaves ? 'llaves' : 'rol')
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request, { params }: Params) {
  const { roleId } = await params
  const user = await actor(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = await prisma.role.findUnique({
    where: { id: roleId }, include: { _count: { select: { memberRoles: true } } },
  })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  // The five Procovar roles are not deletable: every app resolves people through
  // them, so removing one would leave those members with no access at all.
  if (role.isSystem) return NextResponse.json({ error: 'System roles cannot be deleted' }, { status: 400 })

  const rbac = await resolveRbac(user.id, null)
  if (!can(rbac, 'role.delete')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (role._count.memberRoles > 0) {
    return NextResponse.json({ error: 'Role has members assigned; reassign them first' }, { status: 409 })
  }
  // Sin membresías con este rol, pero sí puede ser el rol por defecto de alguien: al borrarlo
  // queda en NULL (`onDelete: SetNull`) y cambia lo que esa persona puede. Se apuntan ANTES.
  const conEsteRol = await personasConRol(roleId, { lanzar: true }) // si falla, que no se borre sin avisar
  await prisma.role.delete({ where: { id: roleId } })
  await publicarPermisosCambiados(conEsteRol, 'rol')
  return NextResponse.json({ ok: true })
}
