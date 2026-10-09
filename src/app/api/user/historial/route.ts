/**
 * GET /api/user/historial?pagina=1 — «Historial de inicios de sesión» de Mi cuenta.
 *
 *   → { filas: FilaDeInicio[], pagina, paginas, total, porPagina }
 *
 * La persona y la sesión actual salen siempre de la cookie, en el servidor: la petición no puede
 * pedir el historial de otra (`userId` no se lee de ningún sitio). `pagina` es 1-based, de 10 en
 * 10; una que no exista (0, -1, «abc», 1e21…) no es un error: se normaliza a una que sí
 * (`paginaValida`). La lógica está en `lib/historial-de-inicios.ts`.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { resolveSessionUser } from '@/lib/require-admin';
import { historialDeInicios } from '@/lib/historial-de-inicios';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
    const actual = await resolveSessionUser();
    if (!actual) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });

    try {
        const pagina = await historialDeInicios(actual.user.id, {
            pagina: new URL(req.url).searchParams.get('pagina'),
            sesionActualId: actual.session.id || null,
        });
        return NextResponse.json(pagina, { headers: SIN_CACHE });
    } catch (e) {
        logger.error('[user/historial] no se pudo leer', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
}
