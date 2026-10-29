/**
 * POST /api/dispositivos/estado — el aparato cuenta cómo le va (`docs/dispositivos.md`, punto 2).
 *
 *   Authorization: Bearer <token de acceso de la aplicación>      X-Aparato-Id: <UUID del aparato>
 *   { ultimaDescarga?, ultimaSubida?, pendientes?, rechazados?, ultimoError? }     (todo opcional; un campo ausente NO borra)
 *
 *   200 { ok: true, revocado: boolean }   `revocado: true` = un administrador bloqueó este aparato: que cierre sesión
 *   200 { ok: true, ignorado: true }      más de una llamada por minuto del mismo aparato: no se anota, no es un error
 *   400 { error: 'invalid_json' | 'invalid_aparato' }
 *   401 { error: 'unauthorized' }         token ausente, caducado o que no es de una aplicación
 *   404 { error: 'aparato_desconocido' }  el aparato no está registrado (se registra al renovar con `X-Aparato-Id`) o no es de esta persona
 *
 * **La persona y la aplicación salen del TOKEN, nunca del cuerpo ni de las cabeceras**: un aparato solo puede contar el
 * estado de una fila donde SU cuenta ya ha entrado (`clientId` del token + `aparatoId` + `userId` del token en `DispositivoPersona`; el estado es de ESA aplicación en el aparato). No es crítico: la aplicación no reintenta en
 * bucle y esto no toca la sesión de nadie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { conTope } from '@/lib/con-tope';
import { verifyJwt } from '@/lib/jwt';
import { PROPOSITO_ACCESO, SECRETO_ACCESO } from '@/lib/apk-tokens';
import { conCors, preflight } from '@/lib/cors-apk';
import { leerCabecerasDeAparato, leerEstadoInformado } from '@/lib/dispositivos';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };
const json = (cuerpo: object, estado = 200) => NextResponse.json(cuerpo, { status: estado, headers: SIN_CACHE });

async function manejar(req: NextRequest) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
    if (!bearer || bearer.length > 4096) return json({ error: 'unauthorized' }, 401);

    let sub: string, azp: string;
    try {
        const c = await verifyJwt<{ sub?: string; azp?: string }>(bearer, { secretEnvVar: SECRETO_ACCESO, purpose: PROPOSITO_ACCESO });
        if (typeof c.sub !== 'string' || typeof c.azp !== 'string') return json({ error: 'unauthorized' }, 401);
        sub = c.sub;
        azp = c.azp;
    } catch {
        return json({ error: 'unauthorized' }, 401);
    }

    const { aparatoId } = leerCabecerasDeAparato(req.headers);
    if (!aparatoId) return json({ error: 'invalid_aparato' }, 400);

    let cuerpo: unknown = {};
    const crudo = await req.text();
    if (crudo.trim()) {
        if (crudo.length > 4096) return json({ error: 'invalid_json' }, 400);
        try {
            cuerpo = JSON.parse(crudo);
        } catch {
            return json({ error: 'invalid_json' }, 400);
        }
    }

    // Una por minuto y aparato. Si el limitador no contesta se sigue: esto no es una puerta de acceso.
    try {
        const rl = await conTope(
            rateLimit({ scope: 'dispositivo-estado', identifier: aparatoId, capacity: 1, refillPerSec: 1 / 60 })
        );
        if (!rl.allowed) return json({ ok: true, ignorado: true });
    } catch (e) {
        logger.warn('[dispositivos/estado] el limitador no contesta; se sigue', { error: (e as Error).message });
    }

    try {
        const fila = await prisma.dispositivoApp.findFirst({
            where: { clientId: azp, dispositivo: { aparatoId } },
            // Solo una cuenta que YA ha entrado en este aparato (varias personas usan un mismo PC) cuenta su estado.
            select: { id: true, bloqueadoAt: true, personas: { where: { userId: sub }, select: { id: true } } },
        });
        // Otra persona con un token válido no puede escribir en una fila donde nunca ha entrado.
        if (!fila || fila.personas.length === 0) return json({ error: 'aparato_desconocido' }, 404);

        const e = leerEstadoInformado(cuerpo);
        await prisma.dispositivoApp.update({
            where: { id: fila.id },
            data: { ...e, estadoAt: new Date(), vistoAt: new Date() },
        });
        return json({ ok: true, revocado: !!fila.bloqueadoAt });
    } catch (e) {
        // Ni 500: la aplicación lo trata como «ahora no» y sigue con su trabajo.
        logger.warn('[dispositivos/estado] no se pudo anotar', { error: (e as Error).message });
        return json({ error: 'comprobacion_no_disponible' }, 503);
    }
}

export async function OPTIONS(req: NextRequest) {
    return preflight(req);
}

export async function POST(req: NextRequest) {
    return conCors(await manejar(req), req);
}
