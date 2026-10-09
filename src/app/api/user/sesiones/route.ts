/**
 * /api/user/sesiones — «Dispositivos y sesiones» de Mi cuenta.
 *
 *   GET  → { sesiones: FilaDeSesion[], truncada: boolean }   las sesiones activas de LA PERSONA de la petición
 *   POST → { accion: 'una', id } | { accion: 'otras' } | { accion: 'todas' }
 *          Sólo desde esta aplicación (`Origin`) y como `application/json`: ver `pedidoDeOtroSitio`.
 *
 * La persona y la sesión actual salen siempre de la cookie, en el servidor; del cuerpo sólo
 * llega el id de la fila que se quiere cerrar, y si no es de esta persona contesta 404 sin
 * tocar nada. Los navegadores y los cortes de seguridad pasan por los caminos de better-auth
 * (`auth.api.revoke*`), que publican el aviso `sesion-cerrada` desde `lib/hooks-de-sesion.ts`
 * (web para un navegador, `todo` para «las demás» y «todos»); un dispositivo de Reparto se cierra
 * por su familia de refresh y NO publica nada. Aquí no se publica a mano.
 * La lógica está en `lib/sesiones-de-la-persona.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { resolveSessionUser } from '@/lib/require-admin';
import { cerrarFamilia } from '@/lib/apk-tokens';
import { filasDeSesiones, revocar, type CaminosDeRevocacion } from '@/lib/sesiones-de-la-persona';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };

/** Los ids (uuid v7, cuid, alfanuméricos de better-auth) son `[\w-]`: nada de NUL ni de otra cosa hacia Prisma. */
const OrdenSchema = z.discriminatedUnion('accion', [
    z.object({ accion: z.literal('una'), id: z.string().regex(/^[\w-]{1,128}$/) }),
    z.object({ accion: z.literal('otras') }),
    z.object({ accion: z.literal('todas') }),
]);

/**
 * Cierra UN aparato: la familia de su refresh y su sesión (`cerrarFamilia`), y sin aviso — no
 * se toca ni a las webs ni a los demás aparatos. Ya viene comprobado que la sesión es de
 * `userId`; aun así la fila de refresh se busca CON `userId`, por si acaso.
 */
async function cerrarAparato(userId: string, sesionId: string): Promise<boolean> {
    const fila = await prisma.refreshToken.findFirst({ where: { userId, sessionId: sesionId }, select: { familyId: true } });
    if (!fila) return false; // sin familia: `revocar` la cierra por better-auth, que BORRA la sesión (un `revokedAt` no lo mira)
    await cerrarFamilia(fila.familyId);
    return true;
}

/** Un máximo de sesiones por lista; si hay más, se avisa (`truncada`) en vez de callar. */
const MAXIMO_DE_SESIONES = 100;

/**
 * Un `POST` que cambia sesiones sólo vale si lo manda esta aplicación: la cookie es de todo
 * `*.procovar.cloud` y SameSite=Lax no detiene una petición de otro subdominio. `Origin` distinto → 403;
 * y el cuerpo ha de ser `application/json`, que un formulario de otro sitio no puede mandar → 415.
 * Un `Origin` vacío cuenta como ausente (un formulario simple no manda JSON, y eso ya lo corta el 415).
 * Si `APP_URL` no sirve para comparar, no se puede decidir: 500 con el motivo en el registro, nunca un TypeError.
 */
function pedidoDeOtroSitio(req: NextRequest): NextResponse | null {
    let propio: string;
    try {
        propio = new URL(process.env.APP_URL ?? 'http://localhost:3500').origin;
        if (propio === 'null') throw new Error('origen opaco'); // `file:`/`data:`: igualaría al `Origin: null` de un iframe ajeno
    } catch {
        logger.error('[user/sesiones] APP_URL no es una dirección http(s) válida: no se puede comprobar el Origin');
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
    const origen = req.headers.get('origin');
    if (origen && origen !== propio) {
        return NextResponse.json({ error: 'origin_no_permitido' }, { status: 403, headers: SIN_CACHE });
    }
    const tipo = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (tipo !== 'application/json') {
        return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415, headers: SIN_CACHE });
    }
    return null;
}

export async function GET() {
    const actual = await resolveSessionUser();
    if (!actual) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });

    try {
        const ahora = new Date();
        // Sin `token`: ese no sale de aquí. Las más recientes primero; se pide una de más para saber si se truncó.
        const traidas = await prisma.session.findMany({
            where: { userId: actual.user.id, revokedAt: null, expiresAt: { gt: ahora } },
            select: {
                id: true,
                userId: true,
                clientId: true,
                ipAddress: true,
                userAgent: true,
                createdAt: true,
                updatedAt: true,
                expiresAt: true,
                revokedAt: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: MAXIMO_DE_SESIONES + 1,
        });
        const truncada = traidas.length > MAXIMO_DE_SESIONES;
        const sesiones = traidas.slice(0, MAXIMO_DE_SESIONES);
        // Cada renovación de un aparato es una fila nueva de `refresh_token`: la más reciente de
        // la sesión es su última actividad. `groupBy` y no `findMany`: son miles por aparato.
        const renovadas = await prisma.refreshToken.groupBy({
            by: ['sessionId'],
            where: { userId: actual.user.id, sessionId: { in: sesiones.map((s) => s.id) } },
            _max: { createdAt: true },
        });
        const filas = filasDeSesiones(sesiones, {
            userId: actual.user.id,
            sesionActualId: actual.session.id || null,
            renovaciones: new Map(
                renovadas.flatMap((r) => (r.sessionId && r._max.createdAt ? [[r.sessionId, r._max.createdAt] as const] : [])),
            ),
            ahora,
        });
        return NextResponse.json({ sesiones: filas, truncada }, { headers: SIN_CACHE });
    } catch (e) {
        logger.error('[user/sesiones] no se pudo listar', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
}

export async function POST(req: NextRequest) {
    const ajeno = pedidoDeOtroSitio(req);
    if (ajeno) return ajeno;
    const actual = await resolveSessionUser();
    if (!actual) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });

    let cuerpo: unknown;
    try {
        cuerpo = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: SIN_CACHE });
    }
    const orden = OrdenSchema.safeParse(cuerpo);
    if (!orden.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: SIN_CACHE });

    const userId = actual.user.id;
    const caminos: CaminosDeRevocacion = {
        revokeSession: (a) => auth.api.revokeSession(a),
        revokeOtherSessions: (a) => auth.api.revokeOtherSessions(a),
        revokeSessions: (a) => auth.api.revokeSessions(a),
        cerrarAparato: (sesionId) => cerrarAparato(userId, sesionId),
    };
    try {
        const resultado = await revocar(
            caminos,
            req.headers,
            { userId, sesionId: actual.session.id || null },
            orden.data,
            async (id) => {
                const fila = await prisma.session.findUnique({ where: { id } });
                if (!fila) return null;
                const refresh = await prisma.refreshToken.findFirst({ where: { sessionId: id }, select: { id: true } });
                return { ...fila, conRefresh: !!refresh };
            },
        );
        if (!resultado.ok) {
            return NextResponse.json({ error: resultado.error }, { status: resultado.estado, headers: SIN_CACHE });
        }
        audit({
            action: orden.data.accion === 'una' ? 'session.revoke' : 'session.revokeAll',
            userId: actual.user.id,
            meta: { desde: 'mi-cuenta', ...orden.data },
        });
        return NextResponse.json({ ok: true }, { headers: SIN_CACHE });
    } catch (e) {
        logger.error('[user/sesiones] no se pudo cerrar', { accion: orden.data.accion, error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
}
