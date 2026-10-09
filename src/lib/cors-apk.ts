/**
 * CORS para las puertas que abre una aplicación de Procovar:
 * `POST /api/auth/token`, `/api/auth/refresh`, `/api/auth/logout` y `/api/auth/entrega`.
 *
 * ## Por qué hizo falta
 *
 * Estas tres rutas se escribieron para la APK, que habla por HTTPS sin
 * navegador delante y por lo tanto sin CORS. El 16/09/2026 se abrió el reparto
 * en un navegador —`https://reparto.procovar.cloud`, que es otro origen que
 * `https://auth.procovar.cloud`— y el acceso no funcionaba: el preflight
 * contestaba 204 **sin una sola cabecera `Access-Control-Allow-*`**, así que el
 * navegador tiraba la petición antes de que saliera.
 *
 * Lo que se ve desde dentro de la aplicación cuando eso pasa es lo peor del
 * asunto: el cliente HTTP no recibe respuesta y lo cuenta como «no hay
 * conexión». O sea, un fallo de configuración del servidor disfrazado de
 * problema de señal, en un producto donde la señal falla de verdad todos los
 * días. Nadie lo habría buscado aquí.
 *
 * ## Lista blanca, nunca `*`
 *
 * `Access-Control-Allow-Origin: *` no vale ni aunque no se usen cookies: estas
 * rutas reciben contraseñas y devuelven tokens de 30 días, y abrirlas a
 * cualquier origen deja que una página cualquiera monte un formulario de
 * Procovar y se lleve el par. Se contesta con el origen que pidió, y sólo si
 * está en la lista.
 *
 * Los orígenes salen de `ORIGENES_APP`, separados por comas, para que añadir un
 * dominio no sea recompilar. Los de `localhost` sólo cuentan fuera de
 * producción: en el servidor, un origen local es alguien probando desde su
 * máquina contra las contraseñas de verdad.
 */
import { NextResponse, type NextRequest } from 'next/server';

const PORDEFECTO = [
    'https://reparto.procovar.cloud',
    'https://entrega.procovar.cloud',
    'https://procovar.cloud',
];

const LOCALES = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function permitidos(): string[] {
    const delEntorno = (process.env.ORIGENES_APP ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    return delEntorno.length > 0 ? delEntorno : PORDEFECTO;
}

/** El origen que se puede devolver, o `null` si no está en la lista. */
export function origenPermitido(req: NextRequest): string | null {
    const origen = req.headers.get('origin');
    if (!origen) return null; // una APK no manda `Origin`: no hay nada que autorizar
    if (permitidos().includes(origen)) return origen;
    if (process.env.NODE_ENV !== 'production' && LOCALES.test(origen)) return origen;
    return null;
}

/**
 * Pone las cabeceras en una respuesta ya hecha. Se llama SIEMPRE, también en el
 * 401 y en el 429: sin ellas el navegador tampoco deja leer el cuerpo del
 * error, y «contraseña incorrecta» se vería otra vez como «sin conexión».
 * También les pone `Cache-Control: no-store`, con o sin `Origin`.
 */
export function conCors<T extends NextResponse>(res: T, req: NextRequest): T {
    // Estas respuestas llevan tokens o dicen qué pasó con uno: ningún proxy ni caché las guarda.
    res.headers.set('Cache-Control', 'no-store');
    const origen = origenPermitido(req);
    if (!origen) return res;
    res.headers.set('Access-Control-Allow-Origin', origen);
    // El origen que se devuelve depende de quién pregunta, así que cualquier
    // caché intermedia tiene que guardar una copia por origen. Sin esto, una
    // caché puede servirle a reparto la cabecera que se calculó para entrega.
    res.headers.append('Vary', 'Origin');
    return res;
}

/** El preflight. Next no lo contesta solo para una ruta de API. */
export function preflight(req: NextRequest): NextResponse {
    const origen = origenPermitido(req);
    if (!origen) return new NextResponse(null, { status: 403 });
    return new NextResponse(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': origen,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type, authorization',
            'Access-Control-Max-Age': '86400',
            Vary: 'Origin',
        },
    });
}
