/**
 * POST /api/auth/token
 *
 * Usuario (o correo) + contraseña → `{ token, refresh_token }`.
 *
 * ## Hoy es la PUERTA DE REPARTO
 *
 * El cliente es siempre `delivery-apk` y exige la llave `delivery.entrar` (lo mismo que
 * `/api/auth/refresh`): sin ella no se emite el par. Cuando entre el CRM habrá que aceptar
 * un `client_id` de lista cerrada, cada uno con su llave (`LLAVE_DEL_CLIENTE`), en vez de
 * esta constante; mientras tanto el CRM NO puede usar esta ruta para entrar. El token que
 * se firma lleva además `entradas`, las llaves `<app>.entrar` de la persona
 * (`entradasDe`), que es lo que lee el servidor de Reparto.
 *
 * Es la puerta de la APK, y la ÚNICA de auth que acepta una contraseña sin
 * navegador. No lleva firma de servicio a propósito: una APK se descompila, así
 * que no puede llevar dentro la clave con la que firman delivery y PEDIDO. Ver
 * `src/lib/apk-tokens.ts` y `delivery-logistica/docs/identidad.md`.
 *
 * Cuerpo:
 *   { email | username | identifier, password, sucursal? }
 *
 * Respuestas:
 *   200 { token, refresh_token, token_type, expires_in, refresh_expires_in }
 *   400 { error: 'invalid_body' }
 *   401 { error: 'invalid_credentials' }        ← siempre el mismo, ver abajo
 *   403 { error: 'sin_sucursal' }
 *   403 { error: 'sin_permiso', codigo: 'sin_permiso' }   ← sin `delivery.entrar`
 *   429 { error: 'rate_limited' }
 *   503 { error: 'rate_limit_unavailable' }
 *   503 { error: 'comprobacion_no_disponible' }   ← la base no contestó al mirar la llave
 *
 * ## Un fallo de la base NO es «sin permiso»
 *
 * La app de Reparto toma el 403 `sin_permiso` por «perdiste el permiso» y se queda en esa
 * pantalla; un 5xx lo trata bien (conserva los tokens y reintenta). Por eso si no se puede
 * comprobar la llave sale 503, no 403, y la sesión que abrió este intento se descarta.
 *
 * ## El 401 es siempre el mismo
 *
 * Usuario que no existe, cuenta sin contraseña, contraseña mal: los tres salen
 * por aquí con el mismo cuerpo y el mismo código. Decir "ese usuario no existe"
 * le confirma a cualquiera qué nombres son reales, y con los nombres de PEDIDO
 * —`yasmani`, `claudia.hab`— eso es media plantilla enumerada desde fuera.
 *
 * ## La contraseña no se comprueba aquí
 *
 * Se delega en `auth.api.signInEmail`, que es el mismo camino que usa el login
 * de la web. Eso trae gratis lo que ya estaba resuelto: leer las contraseñas
 * bcrypt heredadas de PEDIDO y de delivery además de las de better-auth
 * (`lib/auth.ts`), y crear la sesión que luego se puede revocar desde el panel.
 * Escribir aquí una segunda comprobación sería el segundo sitio donde dar de
 * baja a alguien, y el día que se olvide uno, el despedido sigue entrando.
 *
 * Por lo mismo el correo **no se toca**: va tal cual se escribió. Lo que haga
 * better-auth con él después es exactamente lo que ya le pasa al login de la
 * web, y una segunda regla aquí sería una divergencia silenciosa.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import {
    ComprobacionNoDisponible,
    CUERPO_NO_DISPONIBLE,
    CUERPO_SIN_PERMISO,
    comprobarEntrada,
} from '@/lib/puerta-de-entrada';
import { conCors, preflight } from '@/lib/cors-apk';
import {
    CLIENTE_POR_DEFECTO,
    ErrorDeIdentidad,
    desdeDondePide,
    emitirPar,
} from '@/lib/apk-tokens';

const BodySchema = z
    .object({
        // Los tres nombres de lo mismo. El cliente de referencia manda `email`;
        // quien entra con nombre de usuario no tiene correo que mandar.
        email: z.string().min(1).optional(),
        username: z.string().min(1).optional(),
        identifier: z.string().min(1).optional(),
        password: z.string().min(1),
        /** El código de sucursal, sólo para quien esté en más de una. */
        sucursal: z.string().min(1).max(16).optional(),
    })
    .refine((b) => !!(b.email ?? b.username ?? b.identifier), {
        message: 'falta el identificador',
    });

/** Un solo cuerpo para todos los fallos de credencial. Ver la cabecera. */
const credencialesMal = () => NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

/**
 * Borra la sesión de better-auth que acaba de abrir este intento de acceso, y SÓLO esa:
 * se pasa su id, no el de la persona, así que no puede llevarse las demás sesiones de la
 * cuenta (la web, otros aparatos). Se borra y no se «revoca» porque una revocada seguiría
 * saliendo en Personas → Sesiones, como «Revocada», que es justo lo que se quiere evitar.
 *
 * Si no se puede borrar no se cambia la respuesta: la persona ya está denegada, y una
 * sesión de más no abre nada (la APK no la recibe nunca).
 */
async function descartarSesion(sessionId: string) {
    try {
        await prisma.session.deleteMany({ where: { id: sessionId } });
    } catch (e) {
        logger.error('[auth/token] no se pudo descartar la sesión de un acceso denegado', {
            sessionId,
            error: (e as Error).message,
        });
    }
}

async function manejar(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const identificador = (parsed.data.email ?? parsed.data.username ?? parsed.data.identifier ?? '').trim();
    const aparato = { ...desdeDondePide(req.headers), clientId: CLIENTE_POR_DEFECTO };

    // Este es el endpoint que más intentos recibe de todo Procovar. El repo ya
    // traía el cubo de fichas sobre Redis (`lib/rate-limit.ts`, hoy sólo en
    // callback-token) y es el que se usa, con DOS cubos:
    //
    //  - por IP, contra quien prueba muchas cuentas desde un sitio;
    //  - por identificador, contra quien prueba muchas contraseñas de UNA cuenta,
    //    que es el ataque que de verdad entra y que un límite por IP no ve si
    //    reparte los intentos.
    //
    // Los dos tienen que dejar pasar. Y si Redis no contesta, NO se pasa: en la
    // única puerta que acepta contraseñas, quedarse sin límite es peor que
    // quedarse sin servicio un rato.
    try {
        const [porIp, porCuenta] = await Promise.all([
            rateLimit({
                scope: 'apk-token-ip',
                identifier: aparato.ip ?? 'sin-ip',
                capacity: 20,
                refillPerSec: 0.1, // uno cada 10 s en régimen
            }),
            rateLimit({
                scope: 'apk-token-cuenta',
                identifier: identificador.toLowerCase(),
                capacity: 8,
                refillPerSec: 0.033, // uno cada 30 s en régimen
            }),
        ]);
        if (!porIp.allowed || !porCuenta.allowed) {
            audit({
                action: 'auth.apk.rate_limited',
                clientId: CLIENTE_POR_DEFECTO,
                ip: aparato.ip,
                userAgent: aparato.userAgent,
                meta: { identificador },
            });
            return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
        }
    } catch (e) {
        logger.error('[auth/token] el limitador no contesta', { error: (e as Error).message });
        return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
    }

    // Nombre de usuario → su correo, como en `server/auth.server.ts`. Si el nombre
    // no existe se sigue adelante con lo que escribieron, para que el fallo sea el
    // mismo tanto si el nombre no existe como si la contraseña está mal.
    let email = identificador;
    if (!email.includes('@')) {
        const persona = await prisma.user
            .findUnique({ where: { username: email.toLowerCase() }, select: { email: true } })
            .catch(() => null);
        if (persona) email = persona.email;
    }

    let sessionToken: string;
    try {
        const entrada = await auth.api.signInEmail({
            headers: req.headers,
            body: { email, password: parsed.data.password, rememberMe: true },
        });
        sessionToken = entrada.token;
    } catch {
        // Todo lo que falle al comprobar la contraseña sale igual: cuenta que no
        // existe, correo con forma inválida, contraseña mal, cuenta sin credencial.
        audit({
            action: 'auth.apk.login_failed',
            clientId: CLIENTE_POR_DEFECTO,
            ip: aparato.ip,
            userAgent: aparato.userAgent,
            meta: { identificador },
        });
        return credencialesMal();
    }

    // La sesión que acaba de abrir ESTE intento. Si no sale un par de aquí, hay que
    // quitarla: better-auth la creó al comprobar la contraseña y, sin par, nadie la
    // tiene ni la va a usar — pero aparecería en la lista de sesiones de la persona.
    let sesionDeEsteIntento: string | null = null;
    try {
        const sesion = await prisma.session.findUnique({
            where: { token: sessionToken },
            select: { id: true, userId: true },
        });
        if (!sesion) {
            logger.error('[auth/token] entró pero la sesión no está en la base');
            return NextResponse.json({ error: 'internal_error' }, { status: 500 });
        }
        sesionDeEsteIntento = sesion.id;

        // La puerta: la contraseña era buena, pero sin `delivery.entrar` no se emite el
        // par. Es otra cosa que el 401 (credenciales) y que `sin_sucursal` (alcance).
        if (!(await comprobarEntrada(sesion.userId, CLIENTE_POR_DEFECTO))) {
            audit({
                action: 'auth.apk.denied',
                userId: sesion.userId,
                clientId: CLIENTE_POR_DEFECTO,
                ip: aparato.ip,
                userAgent: aparato.userAgent,
                meta: { identificador, sessionId: sesion.id },
            });
            await descartarSesion(sesion.id);
            return NextResponse.json(CUERPO_SIN_PERMISO, { status: 403 });
        }

        const par = await emitirPar({
            userId: sesion.userId,
            sessionId: sesion.id,
            sucursalPedida: parsed.data.sucursal ?? null,
            aparato,
        });

        // La sesión que abre la APK vive lo que vive el refresh. Con la caducidad
        // por defecto de better-auth (7 días) un aparato que renueva sin fallo se
        // habría quedado fuera al octavo, con un refresh de 30 días en la mano.
        await prisma.session.updateMany({
            where: { id: sesion.id },
            data: { expiresAt: new Date(Date.now() + par.refresh_expires_in * 1000), clientId: CLIENTE_POR_DEFECTO },
        });

        audit({
            action: 'auth.apk.login',
            userId: sesion.userId,
            clientId: CLIENTE_POR_DEFECTO,
            ip: aparato.ip,
            userAgent: aparato.userAgent,
            meta: { identificador, sessionId: sesion.id },
        });

        return NextResponse.json(par);
    } catch (e) {
        // Sea la denegación que sea (sin sucursal, de baja) o un fallo nuestro: no hubo par.
        if (sesionDeEsteIntento) await descartarSesion(sesionDeEsteIntento);
        if (e instanceof ComprobacionNoDisponible) {
            // La base no contestó al mirar la llave: ni permiso ni denegación, un fallo nuestro.
            logger.error('[auth/token] no se pudo comprobar la llave de entrada', { error: e.message });
            return NextResponse.json(CUERPO_NO_DISPONIBLE, { status: 503 });
        }
        if (e instanceof ErrorDeIdentidad) {
            // Entró bien: la contraseña era buena. Lo que no hay es alcance que
            // firmarle, y un token sin sucursal en la API del reparto significa
            // LAS OCHO. Se dice lo que pasa, que tiene arreglo (darle su sucursal).
            return NextResponse.json(
                {
                    error: e.motivo,
                    message:
                        e.motivo === 'sin_sucursal'
                            ? 'La cuenta no está dada de alta en ninguna sucursal, o la sucursal pedida no es suya.'
                            : 'La cuenta está dada de baja.',
                },
                { status: 403 }
            );
        }
        logger.error('[auth/token] error', { error: (e as Error).message });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}

// CORS. La puerta se abre tambien desde un navegador —la web del reparto vive en
// otro dominio que auth— y sin estas dos lineas el navegador tira la peticion
// antes de que salga. El porque entero, en `lib/cors-apk.ts`.
export async function OPTIONS(req: NextRequest) {
    return preflight(req);
}

export async function POST(req: NextRequest) {
    return conCors(await manejar(req), req);
}
