/**
 * POST /api/auth/verify
 *
 * Verifies a JWT previously issued by /api/auth/sign (RS256). Convenience
 * endpoint — microservices SHOULD verify locally via /.well-known/jwks.json.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { verifyRs256 } from '@/lib/jwks';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const BodySchema = z.object({
    token: z.string().min(10),
    purpose: z.string().min(1),
    audience: z.union([z.string(), z.array(z.string())]).optional(),
});

export const POST = withServiceAuth(async (req: NextRequest) => {
    let body: unknown;
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    let payload: Awaited<ReturnType<typeof verifyRs256>>;
    try {
        payload = await verifyRs256(parsed.data.token, {
            purpose: `svc:${parsed.data.purpose}`,
            audience: parsed.data.audience,
        });
    } catch (e) {
        return NextResponse.json({ valid: false, error: (e as Error).message }, { status: 401 });
    }

    // Una firma buena no basta si el token nombra a una persona que ya está de baja (`activo=false`):
    // los claims son libres, así que se miran `sub` y `userId`; un id que no es de una persona
    // (p. ej. el `sub` de un JWT de plataforma, que es un clientId) simplemente no encuentra fila.
    const ids = [payload.sub, payload.userId].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length > 0) {
        try {
            const baja = await prisma.user.findFirst({ where: { id: { in: ids }, activo: false }, select: { id: true } });
            if (baja) return NextResponse.json({ valid: false, error: 'user_inactive' }, { status: 401 });
        } catch (e) {
            // Sin poder comprobar la baja no se da por bueno: cerrado, y 503 para que el llamante reintente.
            logger.error('[verify] no se pudo comprobar la baja', { error: (e as Error).message });
            return NextResponse.json({ valid: false, error: 'service_unavailable' }, { status: 503 });
        }
    }
    return NextResponse.json({ valid: true, payload });
}, { scopes: ['jwt:verify'] });
