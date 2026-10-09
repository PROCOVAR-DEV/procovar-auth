import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { resolveRbac } from '@/rbac/resolve-permissions'
import { rbacEnSucursal, rolesEnSucursal } from '@/rbac/en-sucursal'
import { can } from '@/rbac/can'
import { puedeRepartirRol } from '@/rbac/escalafon'
import { PRECEDENCE, ROL_MINIMO } from '@/rbac/system-roles'
import type { ResolvedRbac } from '@/rbac/types'
import { publicarPermisosCambiados } from '@/lib/eventos-de-sesion'

type Params = { params: Promise<{ orgId: string; memberId: string }> }

function isServiceAuth(request: Request): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  const token = m?.[1]; const expected = (process.env.BEARER_TOKEN) || ''
  return !!token && !!expected && token === expected
}

export async function PUT(request: Request, { params }: Params) {
  const { orgId, memberId } = await params
  // Resolve the acting user's rbac so grants can be bounded by it. `actorRbac`
  // is null only for a fully-trusted service call with no acting user (qb-panel
  // does its own gate; forward `x-acting-user-id` to also enforce the guard here).
  let actorRbac: ResolvedRbac | null = null
  let actorId: string | null = null
  if (!isServiceAuth(request)) {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    actorId = session.user.id
    // `rbacEnSucursal`, no `resolveRbac`: sin ser miembro de ESTA sucursal no se
    // reparten roles en ella, aunque el rol de la persona lleve el permiso.
    actorRbac = await rbacEnSucursal(actorId, orgId)
    if (!can(actorRbac, 'member.assignRole')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  } else {
    const actingUserId = request.headers.get('x-acting-user-id')
    if (actingUserId) {
      actorId = actingUserId
      actorRbac = await resolveRbac(actingUserId, orgId)
    }
  }

  // Ensure the member actually belongs to the org in the path (prevents cross-org IDOR).
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { organizationId: true, userId: true } })
  if (!member || member.organizationId !== orgId) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  // An assignment is now just a role: the scope is the member's sucursal, which
  // the member row already carries. `assignments` is still accepted so older
  // callers keep working while the apps migrate.
  const body = await request.json() as {
    roleIds?: string[]
    assignments?: { roleId: string }[]
  }
  const roleIds = [...new Set(body.roleIds ?? (body.assignments ?? []).map((a) => a.roleId))]

  const roles = await prisma.role.findMany({
    where: { id: { in: roleIds } },
    select: { id: true, name: true, permissions: { select: { permission: { select: { key: true } } } } },
  })
  const validIds = new Set(roles.map((r) => r.id))
  const valid = roleIds.filter((id) => validIds.has(id))

  // Privilege-escalation guard: only a role BELOW your own, and never one
  // carrying power you do not hold. Skipped for a fully-trusted service call
  // with no acting user. See `@/rbac/escalafon`.
  if (actorRbac) {
    const mios = actorId ? await rolesEnSucursal(actorId, orgId) : []
    for (const r of roles) {
      const claves = r.permissions.map((p) => p.permission?.key).filter((k): k is string => Boolean(k))
      if (!puedeRepartirRol(actorRbac, mios, { name: r.name, claves })) {
        return NextResponse.json({ error: 'cannot grant a role above your own' }, { status: 403 })
      }
    }
  }

  // Los roles que tenía ANTES: sólo se avisa si se le quita alguno.
  const tenia = await prisma.memberRole.findMany({ where: { memberId }, select: { roleId: true } })
  await prisma.$transaction(async (tx) => {
    await tx.memberRole.deleteMany({ where: { memberId } })
    for (const roleId of valid) {
      await tx.memberRole.create({ data: { memberId, roleId } })
    }
    // `member.role` is a single string that better-auth keeps for itself. The
    // real answer lives in memberRole, so this mirrors the highest-ranking role
    // the person now holds, to keep the two from disagreeing.
    const names = roles.filter((r) => validIds.has(r.id)).map((r) => r.name)
    const principal = PRECEDENCE.find((p) => names.includes(p)) ?? names[0] ?? ROL_MINIMO
    await tx.member.update({ where: { id: memberId }, data: { role: principal } })
  })
  // Añadir roles sólo da acceso: no se publica nada.
  if (tenia.some((t) => !valid.includes(t.roleId))) await publicarPermisosCambiados([member.userId], 'rol')
  return NextResponse.json({ ok: true })
}
