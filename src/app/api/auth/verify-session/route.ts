/**
 * POST /api/auth/verify-session
 *
 * Validates an opaque session token (cookie value) and returns the session
 * + user + organization memberships. Service-auth required.
 *
 * Body: { sessionToken: string }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSessionCookieName } from '@/lib/flow-state';
import { logger } from '@/lib/logger';
import { resolveRbac } from '@/rbac/resolve-permissions';

const BodySchema = z.object({ sessionToken: z.string().min(10) });

export const POST = withServiceAuth(async (req: NextRequest) => {
    let body: unknown;
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const headers = new Headers();
    headers.set('cookie', `${getSessionCookieName()}=${parsed.data.sessionToken}`);

    try {
        const session = await auth.api.getSession({ headers });
        if (!session) return NextResponse.json({ error: 'invalid_session' }, { status: 401 });

        // Revocation check (authoritative). better-auth's getSession honours its own
        // cookie cache and never inspects our custom `revokedAt` column, so a session
        // revoked via /api/auth/revoke-session would otherwise stay valid here (and in
        // qb-back/qb-panel) until natural expiry. Read the source-of-truth flag directly.
        const revocation = await prisma.session.findUnique({
            where: { id: session.session.id },
            select: { revokedAt: true },
        });
        if (revocation?.revokedAt) {
            return NextResponse.json({ error: 'session_revoked' }, { status: 401 });
        }

        // Una cuenta de baja (`activo=false`) con la sesión ya abierta NO vale: better-auth no mira
        // esa columna, y las apps que solo llaman aquí la seguirían aceptando. Mismo 401 y mismo
        // código que una sesión inválida (nada que enseñarle a quien pregunta).
        const persona = await prisma.user.findUnique({
            where: { id: session.user.id },
            select: {
                activo: true,
                defaultRole: { select: { name: true } },
                members: {
                    select: { memberRoles: { select: { role: { select: { name: true } } } } },
                },
            },
        });
        if (persona?.activo === false) {
            return NextResponse.json({ error: 'invalid_session' }, { status: 401 });
        }

        const memberRows = await prisma.member.findMany({
            where: { userId: session.user.id },
            select: {
                id: true, role: true, createdAt: true,
                organization: { select: { id: true, name: true, slug: true, logo: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        // `role` is internal only (better-auth stores roles comma-joined). Expose the
        // parsed `roles` array + the `organization` object; drop the redundant singular
        // `role` and `organizationId` (org.id covers it).
        const memberships = memberRows.map(({ role, ...m }) => ({
            ...m,
            roles: (role ?? '').split(',').map((r) => r.trim()).filter(Boolean),
        }));
        // Resolved RBAC for the session's active org — consumed by qb-panel
        // (server actions + claim forwarding) and qb-back (session-cookie path).
        // Fallback: when no active org is set but the user belongs to exactly one
        // org, resolve for that org. The panel is URL-driven and does not set
        // better-auth's activeOrganizationId, so a single-org owner would otherwise
        // get an empty rbac (resolved for "no org") and be denied everything.
        const rbacOrgId =
            session.session.activeOrganizationId ??
            (memberRows.length === 1 ? memberRows[0].organization.id : null);
        const rbac = await resolveRbac(session.user.id, rbacOrgId);

        // El NOMBRE del rol y los permisos, que es lo que consume cada aplicación.
        //
        // `memberships[].roles` no sirve para eso: ahí va la columna `role` de
        // better-auth, que guarda "owner"/"member" —su vocabulario, no el catálogo de
        // Procovar—. Quien la leyera buscando "SUPERVISOR" no lo encontraba nunca, se
        // quedaba sin rol y por tanto sin entrar. Le pasó a una supervisora en Rutas:
        // 403, sin nombre, sin menú y sin poder cerrar sesión.
        //
        // El rol de verdad es el de la PERSONA: el mismo en todas sus sucursales.
        const roles = [
            ...(persona?.defaultRole?.name ? [persona.defaultRole.name] : []),
            ...(persona?.members ?? []).flatMap((m) => m.memberRoles.map((mr) => mr.role.name)),
        ];

        return NextResponse.json({
            valid: true,
            ...session,
            memberships,
            role: persona?.defaultRole?.name ?? null,
            rbac: {
                ...rbac,
                roles: [...new Set(roles)],
                // El mismo listado con el nombre por el que preguntan.
                permissions: rbac.global,
            },
        });
    } catch (e) {
        logger.error('[verify-session] error', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}, { scopes: ['session:verify'] });
