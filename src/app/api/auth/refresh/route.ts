/**
 * POST /api/auth/refresh
 *
 * Refresh → par NUEVO, los dos tokens. El que se presenta queda gastado.
 *
 * Cuerpo: { refresh_token }   (`refresh` vale como alias de entrada)
 *
 * Respuestas:
 *   200 { token, refresh_token, token_type, expires_in, refresh_expires_in }
 *   400 { error: 'invalid_body' }
 *   401 { error: 'invalid_refresh' }
 *   403 { error: 'sin_permiso', codigo: 'sin_permiso' }   ← ya no tiene `delivery.entrar`
 *   503 { error: 'comprobacion_no_disponible' }           ← la base no contestó al mirarlo
 *
 * Hoy esta ruta es la PUERTA DE REPARTO, como `/api/auth/token`: el cliente es siempre
 * `delivery-apk` y se renueva con `delivery.entrar`. Cuando entre el CRM habrá que aceptar
 * un `client_id` de lista cerrada con su llave (`LLAVE_DEL_CLIENTE`). El acceso que sale
 * lleva `entradas` (las llaves `<app>.entrar` de la persona), re-firmadas en cada renovación.
 *
 * ## El 403 y el 503 son los ÚNICOS fallos que no son un 401, y es a propósito
 *
 * Renovar es seguir entrando, así que se pide la misma llave que en el login
 * (`lib/puerta-de-entrada.ts`). Sin ella no se renueva y NO se gasta el refresh:
 * no se cierra nada, y si se la devuelven el mismo refresh vuelve a valer. No es un
 * 401 porque el 401 significa «la sesión murió: limpia» y esto sí tiene arreglo.
 *
 * Y si la base no contesta al comprobar la llave NO es un 403: la app toma el 403 por
 * «perdiste el permiso» y se queda en esa pantalla hasta recargar. Sale 503, que la app
 * trata como una caída pasajera (conserva los tokens y reintenta), y el refresh no se gasta.
 *
 * ## Es lo primero que hace la APK al arrancar
 *
 * No se comprueba el acceso por su cuenta: dura 15 minutos, así que casi siempre
 * estará caducado al abrir la aplicación, y eso no significa que la sesión haya
 * muerto. Renovar hace las dos cosas a la vez — si el par sirve devuelve uno
 * nuevo, y si no, no sirve.
 *
 * ## Por qué todos los fallos son un 401 igual
 *
 * Del otro lado, el 401 es lo ÚNICO que significa "la sesión murió: limpia y a
 * la pantalla de acceso". Un token inventado, uno caducado, uno revocado y uno
 * robado acaban todos en lo mismo desde el aparato, así que distinguirlos en la
 * respuesta sólo le contaría a quien prueba tokens en qué estado están las
 * filas. Lo que sí queda distinguido es el registro: la reutilización se audita
 * como `auth.refresh.reuse` y se lleva por delante la cuenta entera.
 *
 * Y por lo mismo un fallo de red o un 5xx NO pueden salir como 401: el cliente
 * los trata distinto —conserva los tokens y reintenta— y un 401 por una caída
 * pasajera deja al logístico a pie con el trabajo del día dentro del teléfono.
 * Por eso el limitador de aquí NO cierra la puerta si Redis no contesta.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { CLIENTE_POR_DEFECTO, desdeDondePide, renovar } from '@/lib/apk-tokens';
import { ComprobacionNoDisponible, CUERPO_NO_DISPONIBLE, CUERPO_SIN_PERMISO } from '@/lib/puerta-de-entrada';
import { conCors, preflight } from '@/lib/cors-apk';

const BodySchema = z
    .object({
        refresh_token: z.string().min(1).optional(),
        refresh: z.string().min(1).optional(),
    })
    .refine((b) => !!(b.refresh_token ?? b.refresh), { message: 'falta el refresh' });

async function manejar(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const aparato = { ...desdeDondePide(req.headers), clientId: CLIENTE_POR_DEFECTO };

    // Un tope por IP, holgado: aquí la protección de verdad es el propio token, y
    // un aparato que recupera señal dispara su cola entera de golpe. Si el
    // limitador no contesta se sigue adelante — cerrar por eso sería un 401 con
    // forma de "sesión muerta" en plena calle.
    try {
        const rl = await rateLimit({
            scope: 'apk-refresh',
            identifier: aparato.ip ?? 'sin-ip',
            capacity: 120,
            refillPerSec: 2,
        });
        if (!rl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    } catch (e) {
        logger.warn('[auth/refresh] el limitador no contesta; se sigue', {
            error: (e as Error).message,
        });
    }

    try {
        const salida = await renovar((parsed.data.refresh_token ?? parsed.data.refresh)!, aparato);
        if (!salida.ok) {
            if (salida.motivo === 'sin_permiso') return NextResponse.json(CUERPO_SIN_PERMISO, { status: 403 });
            return NextResponse.json({ error: 'invalid_refresh' }, { status: 401 });
        }
        return NextResponse.json(salida.par);
    } catch (e) {
        if (e instanceof ComprobacionNoDisponible) {
            logger.error('[auth/refresh] no se pudo comprobar la llave de entrada', { error: e.message });
            return NextResponse.json(CUERPO_NO_DISPONIBLE, { status: 503 });
        }
        logger.error('[auth/refresh] error', { error: (e as Error).message });
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
