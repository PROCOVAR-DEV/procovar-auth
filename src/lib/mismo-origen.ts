/**
 * Un `POST` que cambia cosas desde el panel solo vale si lo manda ESTA aplicación: la cookie es de todo `*.procovar.cloud` y
 * SameSite=Lax no detiene una petición de otro subdominio. `Origin` distinto → 403; y el cuerpo ha de ser `application/json`,
 * que un formulario de otro sitio no puede mandar → 415. (Misma comprobación que `app/api/user/sesiones`.)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';

const SIN_CACHE = { 'Cache-Control': 'no-store' };

/**
 * `tiposAdmitidos`: por defecto solo JSON. La subida de una APK manda el fichero tal cual (`application/octet-stream`):
 * tampoco es un tipo que un formulario de otro sitio pueda enviar sin pasar por CORS, que es lo que se busca.
 */
export function pedidoDeOtroSitio(req: NextRequest, tiposAdmitidos: readonly string[] = ['application/json']): NextResponse | null {
    let propio: string;
    try {
        propio = new URL(process.env.APP_URL ?? 'http://localhost:3500').origin;
        if (propio === 'null') throw new Error('origen opaco');
    } catch {
        logger.error('[mismo-origen] APP_URL no es una dirección http(s) válida: no se puede comprobar el Origin');
        return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: SIN_CACHE });
    }
    const origen = req.headers.get('origin');
    if (origen && origen !== propio) {
        return NextResponse.json({ error: 'origin_no_permitido' }, { status: 403, headers: SIN_CACHE });
    }
    const tipo = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!tipo || !tiposAdmitidos.includes(tipo)) {
        return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415, headers: SIN_CACHE });
    }
    return null;
}
