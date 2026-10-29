/**
 * POST /api/admin/dispositivos/{id} — lo que un administrador hace con un aparato (`docs/dispositivos.md`).
 *
 *   { accion: 'nombre', nombre: string | null }   le pone nombre (1–80 car.; vacío o null = quitárselo)
 *   { accion: 'cerrar' }                          cierra su sesión: deja de renovar y sale (puede volver a entrar)
 *   { accion: 'bloquear' }                        cierra su sesión Y no vuelve a entrar con ese `X-Aparato-Id`
 *   { accion: 'desbloquear' }                     le deja volver
 *
 * Solo el administrador global (como todo el panel `/dashboard`). `{id}` es el de la fila, nunca el `aparatoId`. Cada acción
 * queda en la auditoría y AVISA a la aplicación dueña del aparato por su canal de Redis (`lib/eventos-de-dispositivos.ts`),
 * que corta al momento sin sondear; si el aviso falla, la acción YA está hecha y la aplicación se pone al día con su lista.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireSystemAdmin } from '@/lib/require-admin';
import { desdeDondePide } from '@/lib/apk-tokens';
import { pedidoDeOtroSitio } from '@/lib/mismo-origen';
import { aplicarOrden } from '@/lib/dispositivos-acciones';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };
const json = (cuerpo: object, estado = 200) => NextResponse.json(cuerpo, { status: estado, headers: SIN_CACHE });

const Orden = z.discriminatedUnion('accion', [
    z.object({ accion: z.literal('nombre'), nombre: z.string().max(200).nullable() }),
    z.object({ accion: z.literal('cerrar') }),
    z.object({ accion: z.literal('bloquear') }),
    z.object({ accion: z.literal('desbloquear') }),
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const ajeno = pedidoDeOtroSitio(req);
    if (ajeno) return ajeno;

    const admin = await requireSystemAdmin();
    if (admin instanceof NextResponse) return admin;

    const { id } = await params;
    if (!/^[\w-]{1,128}$/.test(id)) return json({ error: 'not_found' }, 404);

    let cuerpo: unknown;
    try {
        cuerpo = await req.json();
    } catch {
        return json({ error: 'invalid_json' }, 400);
    }
    const orden = Orden.safeParse(cuerpo);
    if (!orden.success) return json({ error: 'invalid_body' }, 400);

    try {
        const fila = await prisma.dispositivo.findUnique({
            where: { id },
            select: { id: true, clientId: true, aparatoId: true, userId: true, familyId: true, bloqueadoAt: true },
        });
        if (!fila) return json({ error: 'not_found' }, 404);

        const r = await aplicarOrden(fila, orden.data, { id: admin.user.id, via: 'panel' }, desdeDondePide(req.headers));
        if (!r.ok) return json({ error: r.error }, r.estado);
        return json({ ok: true });
    } catch (e) {
        logger.error('[admin/dispositivos] error', { error: (e as Error).message });
        return json({ error: 'internal_error' }, 500);
    }
}
