import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { rbacEnSucursal } from '@/rbac/en-sucursal'
import { can } from '@/rbac/can'

type Params = { params: Promise<{ orgId: string }> }

function isServiceAuth(request: Request): boolean {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  const token = m?.[1]
  const expected = (process.env.BEARER_TOKEN) || ''
  return !!token && !!expected && token === expected
}

async function gate(request: Request, orgId: string) {
  if (isServiceAuth(request)) return { ok: true as const }
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  // Sólo en las sucursales donde quien pregunta es miembro (ver `rbacEnSucursal`).
  const rbac = await rbacEnSucursal(session.user.id, orgId)
  if (!can(rbac, 'member.invite')) return { ok: false as const, status: 403, error: 'Forbidden' }
  return { ok: true as const }
}

/**
 * GET /api/rbac/orgs/:orgId/user-search?q=...
 * Type-ahead for the invite flow: returns existing users whose email or name
 * matches `q`, EXCLUDING those already members of this org. Requires member.invite.
 */
export async function GET(request: Request, { params }: Params) {
  const { orgId } = await params
  const g = await gate(request, orgId)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ users: [] })

  // Broad DB fetch (matches email or name anywhere), then rank by relevance and
  // DROP domain-only matches: typing "cliente" must NOT surface ana@cliente.com
  // just because the query hit the email domain — only the name or the email's
  // local part (before @) count.
  const candidates = await prisma.user.findMany({
    where: {
      members: { none: { organizationId: orgId } },
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, name: true, image: true },
    take: 30,
  })

  const ql = q.toLowerCase()
  const scored = candidates
    .map((u) => {
      const email = u.email.toLowerCase()
      const local = email.split('@')[0]
      const name = (u.name ?? '').toLowerCase()
      let score = Infinity
      if (local.startsWith(ql) || name.startsWith(ql)) score = 0
      else if (name.split(/\s+/).some((w) => w.startsWith(ql))) score = 1
      else if (local.includes(ql)) score = 2
      else if (name.includes(ql)) score = 3
      // else: only the email domain matched → irrelevant, dropped (Infinity).
      return { u, score }
    })
    .filter((s) => s.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.u.email.localeCompare(b.u.email))
    .slice(0, 8)
    .map((s) => s.u)

  return NextResponse.json({ users: scored })
}
