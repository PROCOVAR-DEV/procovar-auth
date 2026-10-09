/**
 * POST /api/auth/revoke-session
 *
 * Marks a session as revoked (sets `revokedAt`) and pushes it to a Redis
 * revocation list so caches can be invalidated. Service-auth required.
 *
 * Body: { sessionId: string } OR { userId: string }  (revokes all)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { audit } from '@/lib/audit';
import { publicarSesionCerrada } from '@/lib/eventos-de-sesion';

// Tope de longitud: el `userId` acaba en la clave de Redis y en el mensaje que reciben TODAS las aplicaciones.
const BodySchema = z
    .object({ sessionId: z.string().min(1).max(128).optional(), userId: z.string().min(1).max(128).optional() })
    .refine((d) => !!(d.sessionId || d.userId), { message: 'Provide sessionId or userId' });

export const POST = withServiceAuth(async (req: NextRequest, ctx) => {
    let body: unknown;
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const now = new Date();
    // `expiresAt = now` además de `revokedAt`: better-auth no conoce `revokedAt`, y caducarla es lo que hace que
    // `getSession` dé null en TODAS las rutas (callback, exchange, organizaciones, rbac…), no sólo en las que lo miran.
    const revocada = { revokedAt: now, expiresAt: now };
    let count = 0;
    const ids: string[] = [];
    let persona: string | null = null; // de quién eran las sesiones

    if (parsed.data.sessionId) {
        const r = await prisma.session.update({
            where: { id: parsed.data.sessionId },
            data: revocada,
            select: { id: true, userId: true },
        }).catch(() => null);
        if (r) { count = 1; ids.push(r.id); persona = r.userId; }
    } else if (parsed.data.userId) {
        // Que la persona exista ANTES de revocar y de publicar: un id inventado no llega a las aplicaciones.
        const existe = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
        if (!existe) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
        const r = await prisma.session.updateMany({
            where: { userId: parsed.data.userId, revokedAt: null },
            data: revocada,
        });
        count = r.count;
        persona = parsed.data.userId;
        const list = await prisma.session.findMany({ where: { userId: parsed.data.userId }, select: { id: true } });
        ids.push(...list.map((s) => s.id));
    }

    if (ids.length) {
        const redis = getRedis('sessions');
        const pipe = redis.pipeline();
        for (const id of ids) pipe.set(`session:revoked:${id}`, '1', 'EX', 60 * 60 * 24);
        await pipe.exec();
    }

    // Después de la base y de la lista de Redis: ya está revocada. Avisa a las aplicaciones.
    if (persona) await publicarSesionCerrada([persona], 'revocada');

    audit({
        action: 'session.revoke',
        clientId: ctx.client.clientId,
        userId: parsed.data.userId ?? null,
        meta: { sessionId: parsed.data.sessionId ?? null, count },
    });
    return NextResponse.json({ revoked: count });
}, { scopes: ['session:revoke'] });
