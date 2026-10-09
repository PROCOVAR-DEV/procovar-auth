/**
 * GET /api/user/historial?limite=10&desde=<ISO> — «Historial de inicios de sesión» de Mi cuenta.
 *
 *   → { filas: FilaDeInicio[], siguiente: string | null }
 *
 * La persona y la sesión actual salen siempre de la cookie, en el servidor: la petición no puede
 * pedir el historial de otra (`userId` no se lee de ningún sitio). `limite` se recorta a 50 y
 * `desde` es la fecha del último visto. La lógica está en `lib/historial-de-inicios.ts`.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { resolveSessionUser } from '@/lib/require-admin';
import { historialDeInicios, limiteDePagina } from '@/lib/historial-de-inicios';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
    const actual = await resolveSessionUser();
    if (!actual) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });

    const params = new URL(req.url).searchParams;
    const crudo = params.get('desde');
    const desde = crudo ? new Date(crudo) : null;
    if (desde && Number.isNaN(desde.getTime())) {
        return NextResponse.json({ error: 'invalid_desde' }, { status: 400, headers: SIN_CACHE });
    }

    try {
        const pagina = await historialDeInicios(actual.user.id, {
            limite: limiteDePagina(params.get('limite')),
            desde,
            sesionActualId: actual.session.id || null,
        });
        return NextResponse.json(pagina, { headers: SIN_CACHE });
    } catch (e) {
        logger.error('[user/historial] no se pudo leer', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
}
