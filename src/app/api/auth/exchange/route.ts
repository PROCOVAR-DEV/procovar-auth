/**
 * POST /api/auth/exchange
 *
 * The external app posts the `?code=` it just received, and gets back the
 * validated session + user + memberships.
 *
 * Service-auth REQUIRED. The code is bound to the issuing clientId so a
 * different microservice cannot redeem it. Codes are single-use and TTL 60s.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { consumeAuthCode } from '@/lib/auth-code';
import { getSessionCookieName } from '@/lib/flow-state';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

const BodySchema = z.object({ code: z.string().min(32) });

export const POST = withServiceAuth(async (req: NextRequest, ctx) => {
    let body: unknown;
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const expectedClientId = ctx.client.clientId.startsWith('legacy:') ? undefined : ctx.client.clientId;
    const codePayload = await consumeAuthCode(parsed.data.code, expectedClientId);
    if (!codePayload) {
        return NextResponse.json({ error: 'invalid_or_expired_code' }, { status: 401 });
    }

    try {
        const cookieName = getSessionCookieName();
        const headers = new Headers();
        headers.set('cookie', `${cookieName}=${codePayload.sessionToken}`);
        const session = await auth.api.getSession({ headers });
        if (!session) {
            return NextResponse.json({ error: 'session_no_longer_valid' }, { status: 401 });
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

        audit({
            action: 'auth.code.exchange',
            clientId: ctx.client.clientId,
            userId: session.user.id,
            meta: { sessionId: session.session.id },
        });

        /*
         * EL ROL DE LA PERSONA, que es lo que consume cada aplicación.
         *
         * `memberships[].roles` NO sirve para esto y aquí era lo único que salía. Ahí va
         * la columna `role` de better-auth, que guarda su vocabulario —«owner», «member»—
         * y no el catálogo de Procovar. Quien la leyera buscando «SUPER ADMIN» no lo
         * encontraba nunca, se quedaba sin rol, y sin rol se cae al de menos permisos.
         *
         * `verify-session`, aquí al lado, ya lo hacía bien desde que le pasó a una
         * supervisora en Rutas. A este endpoint se le quedó sin arreglar, y por eso AFT
         * metía a TODO el que entraba como `usuario`.
         *
         * Y el caso que lo destapó es el peor de todos: un SUPER ADMIN **no pertenece a
         * ninguna sucursal** —precisamente por eso las ve todas—, así que no tiene ni una
         * membresía de la que sacar nada. Diez cuentas SUPER ADMIN entraban sin rol y sin
         * sucursal, o sea sin ver nada, y la pantalla decía «no tienes sucursal asignada»
         * como si fuera cosa suya. Jose, 30/09/2026.
         *
         * El rol de verdad es el de la PERSONA: el mismo en todas sus sucursales.
         */
        const persona = await prisma.user.findUnique({
            where: { id: session.user.id },
            select: {
                defaultRole: { select: { name: true } },
                members: {
                    select: { memberRoles: { select: { role: { select: { name: true } } } } },
                },
            },
        });
        const roles = [
            ...(persona?.defaultRole?.name ? [persona.defaultRole.name] : []),
            ...(persona?.members ?? []).flatMap((m) => m.memberRoles.map((mr) => mr.role.name)),
        ];

        return NextResponse.json({
            ...session,
            memberships,
            // Mismos dos campos y mismos nombres que `verify-session`: quien consuma los
            // dos endpoints no tiene que aprenderse dos formas de lo mismo.
            role: persona?.defaultRole?.name ?? null,
            roles,
            sessionToken: codePayload.sessionToken,
            returnTo: codePayload.returnTo ?? null,
        });
    } catch (e) {
        logger.error('[auth/exchange] error', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
});
