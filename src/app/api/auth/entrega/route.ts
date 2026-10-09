/**
 * POST /api/auth/entrega
 *
 * Un token de ENTREGA para quien conserva sesión viva pero ya NO tiene `delivery.entrar`: lo único
 * que puede hacer con él es dejar su trabajo sin enviar en la bandeja de revisión de Reparto.
 * El diseño entero está en `delivery-logistica/docs/bandeja-de-revision.md` (B.1) y la regla en
 * `emitirEntrega` (`lib/apk-tokens.ts`).
 *
 * Cuerpo: { refresh_token }   (`refresh` vale como alias, igual que en `/refresh`)
 *
 * **No gasta el refresh y no devuelve refresh.**
 *
 * Respuestas:
 *   200 { token, token_type: 'Bearer', expires_in: 600, ambito: 'reparto.entrega' }
 *   400 { error: 'invalid_json' | 'invalid_body' }
 *   401 { error: 'invalid_refresh' }     ← refresh inexistente, gastado, revocado o caducado; sesión revocada o caducada; baja
 *   403 { error: 'sin_sucursal', message } ← entró bien pero no hay alcance que firmarle
 *   409 { error: 'tiene_permiso', codigo: 'tiene_permiso' }   ← SÍ tiene `delivery.entrar`: que renueve con `/refresh`
 *   429 { error: 'rate_limited' }
 *   503 { error: 'comprobacion_no_disponible' }   ← la base o el limitador no contestaron
 *
 * ## El 503 es cualquier cosa que no se pudo comprobar, y no es un 403 ni un 401
 *
 * La app conserva toda su cola y reintenta: un fallo nuestro tomado por «sin permiso» o por «sesión
 * muerta» la dejaría con el trabajo del día dentro del teléfono y sin salida. Por eso aquí NO hay 500:
 * esta ruta sólo lee y firma, y si algo se rompe en medio no hay nada que deshacer.
 *
 * ## El limitador SÍ cierra la puerta si Redis no contesta
 *
 * A diferencia de `/refresh` (donde cerrar sería un 401 con forma de «sesión muerta» en plena calle),
 * esta es una puerta NUEVA que firma un token: sin límite, quien tenga un refresh podría pedirlos sin
 * parar. Se limita por IP (holgado: detrás de un mismo NAT de operador hay mucha gente) y por huella
 * del refresh (estricto: una persona entrega con un toque, no veinte por minuto).
 */
import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { conTope } from '@/lib/con-tope';
import { logger } from '@/lib/logger';
import { CLIENTE_POR_DEFECTO, desdeDondePide, emitirEntrega } from '@/lib/apk-tokens';
import { CUERPO_NO_DISPONIBLE } from '@/lib/puerta-de-entrada';
import { conCors, preflight } from '@/lib/cors-apk';

const BodySchema = z
    .object({
        // El refresh de verdad mide 43 caracteres: el tope sólo evita que un cuerpo enorme pase zod y se hashee.
        refresh_token: z.string().min(1).max(256).optional(),
        refresh: z.string().min(1).max(256).optional(),
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
    const refresh = (parsed.data.refresh_token ?? parsed.data.refresh)!;

    const aparato = { ...desdeDondePide(req.headers), clientId: CLIENTE_POR_DEFECTO };

    try {
        // `conTope`: con Redis colgado, rateLimit no rechaza nunca; sin él esta puerta no contestaba.
        const [porIp, porRefresh] = await conTope(Promise.all([
            rateLimit({
                scope: 'apk-entrega-ip',
                identifier: aparato.ip ?? 'sin-ip',
                capacity: 60,
                refillPerSec: 1,
            }),
            rateLimit({
                scope: 'apk-entrega-refresh',
                // La huella, no el refresh: en Redis no se guarda nada que sirva para entrar.
                identifier: createHash('sha256').update(refresh).digest('hex').slice(0, 24),
                capacity: 10,
                refillPerSec: 0.1, // uno cada 10 s en régimen
            }),
        ]));
        if (!porIp.allowed || !porRefresh.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    } catch (e) {
        logger.error('[auth/entrega] el limitador no contesta: no se abre', { error: (e as Error).message });
        return NextResponse.json(CUERPO_NO_DISPONIBLE, { status: 503 });
    }

    try {
        const salida = await emitirEntrega(refresh, aparato);
        if (salida.ok) {
            return NextResponse.json({
                token: salida.token,
                token_type: 'Bearer',
                expires_in: salida.expires_in,
                ambito: salida.ambito,
            });
        }
        switch (salida.motivo) {
            case 'tiene_permiso':
                return NextResponse.json({ error: 'tiene_permiso', codigo: 'tiene_permiso' }, { status: 409 });
            case 'sin_sucursal':
                return NextResponse.json(
                    {
                        error: 'sin_sucursal',
                        message: 'La cuenta no está dada de alta en ninguna sucursal, o la sucursal pedida no es suya.',
                    },
                    { status: 403 }
                );
            default:
                // Todos los demás motivos, con el MISMO cuerpo que `/refresh`: distinguirlos sólo le
                // contaría a quien prueba tokens en qué estado están las filas. El motivo queda en la auditoría.
                return NextResponse.json({ error: 'invalid_refresh' }, { status: 401 });
        }
    } catch (e) {
        logger.error('[auth/entrega] no se pudo comprobar', { error: (e as Error).message });
        return NextResponse.json(CUERPO_NO_DISPONIBLE, { status: 503 });
    }
}

// CORS como el resto de las puertas de la APK (`lib/cors-apk.ts`).
export async function OPTIONS(req: NextRequest) {
    return preflight(req);
}

export async function POST(req: NextRequest) {
    return conCors(await manejar(req), req);
}
