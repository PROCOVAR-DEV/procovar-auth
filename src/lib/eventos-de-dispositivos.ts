/**
 * EL AVISO A LAS APLICACIONES DE QUE UN APARATO CAMBIÓ — `docs/dispositivos.md` (29/10/2026).
 *
 * Cuando un administrador bloquea, desbloquea, cierra la sesión o renombra un aparato en Accesos, la aplicación a la que
 * pertenece tiene que enterarse AL MOMENTO (el CRM corta el aparato sin sondear). Mismo estilo que
 * `eventos-de-sesion.ts`, pero SIN marca de recuperación ni cola de reintentos:
 *
 *  - UN CANAL POR APLICACIÓN: `procovar:auth:dispositivos:<clientId>` (p. ej. `procovar:auth:dispositivos:crm-apk`), SIN el
 *    prefijo de ioredis. Cada aplicación se suscribe al suyo y no recibe los de las demás. (El Redis es compartido y no tiene
 *    ACL —CLAUDE.md de delivery-logistica—: el canal separa, no protege; el mensaje solo lleva ids, y los datos del aparato
 *    solo se leen con la credencial de servicio.)
 *  - Mensaje: `{"v":1,"tipo":"dispositivo-cambiado","app":"crm-apk","aparatoId":"<uuid v7>","estado":"activo"|"bloqueado",
 *    "motivo":"bloqueado"|"desbloqueado"|"sesion-cerrada"|"renombrado","tms":<ms>}`.
 *  - **El aviso puede perderse** (Redis caído, la aplicación reiniciándose): por eso la fuente de verdad es
 *    `GET /api/service/dispositivos` (con `desde=`), que la aplicación consulta al arrancar y al reconectar. El aviso sirve
 *    para no tener que consultar a cada rato, no para sustituir la lista.
 *
 * Un fallo de Redis NUNCA rompe la acción del administrador: ya está hecha en la base. Nada de aquí lanza.
 */
import type Redis from 'ioredis';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { conTope } from '@/lib/con-tope';

export const CANAL_DE_DISPOSITIVOS = 'procovar:auth:dispositivos';

/** El canal de UNA aplicación. */
export const canalDe = (clientId: string): string => `${CANAL_DE_DISPOSITIVOS}:${clientId}`;

export type MotivoDeDispositivo = 'bloqueado' | 'desbloqueado' | 'sesion-cerrada' | 'renombrado';

export interface AvisoDeDispositivo {
    v: 1;
    tipo: 'dispositivo-cambiado';
    app: string;
    aparatoId: string;
    estado: 'activo' | 'bloqueado';
    motivo: MotivoDeDispositivo;
    tms: number;
}

declare global {
    var __procovarDispositivosRedis: Redis | undefined;
}

function cliente(): Redis {
    if (!globalThis.__procovarDispositivosRedis) {
        const c = getRedis('sessions').duplicate({ keyPrefix: '', enableAutoPipelining: false });
        c.on('error', (err) => logger.warn('[eventos-de-dispositivos] redis', { msg: err.message }));
        globalThis.__procovarDispositivosRedis = c;
    }
    return globalThis.__procovarDispositivosRedis;
}

/** El mensaje, hecho aparte para poder probarlo sin Redis. */
export function avisoDe(
    d: { clientId: string; aparatoId: string; bloqueadoAt: Date | null },
    motivo: MotivoDeDispositivo,
    ahora: number = Date.now()
): AvisoDeDispositivo {
    return {
        v: 1,
        tipo: 'dispositivo-cambiado',
        app: d.clientId,
        aparatoId: d.aparatoId,
        estado: d.bloqueadoAt ? 'bloqueado' : 'activo',
        motivo,
        tms: ahora,
    };
}

/** Publica el aviso. **No lanza**; devuelve si llegó a publicarse (para las pruebas y el registro). */
export async function avisarDeDispositivo(
    d: { clientId: string; aparatoId: string; bloqueadoAt: Date | null },
    motivo: MotivoDeDispositivo
): Promise<boolean> {
    const aviso = avisoDe(d, motivo);
    try {
        await conTope(cliente().publish(canalDe(aviso.app), JSON.stringify(aviso)), 1000);
        return true;
    } catch (e) {
        logger.warn('[eventos-de-dispositivos] no se pudo publicar; la aplicación se pondrá al día con su lista', {
            error: (e as Error).message,
            app: aviso.app,
            motivo,
        });
        return false;
    }
}
