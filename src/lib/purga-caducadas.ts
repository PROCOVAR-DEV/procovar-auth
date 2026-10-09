/**
 * Purga de lo caducado: `session` y `refresh_token`.
 *
 * Nadie las limpiaba: las dos tablas sólo crecían. Se borra lo que caducó hace MÁS de 30 días
 * (`expiresAt < ahora - 30 días`).
 *
 * El margen de 30 días no es capricho. Una fila de `refresh_token` ya gastada se CONSERVA a
 * propósito para reconocer la REUTILIZACIÓN (robo) mientras el token pudiera estar vivo: la purga
 * no puede llevársela antes. Con `expiresAt` 30 días en el pasado ya no sirve a nadie, ni como
 * token ni como prueba de robo. Por la misma razón NO se mira `usedAt` ni `revokedAt`: una fila
 * usada o revocada pero todavía no caducada se queda hasta que caduque.
 *
 * En lotes (1000 por pasada, hasta 20 pasadas por tabla y por ejecución) para no bloquear la tabla
 * con un DELETE gigante; lo que sobre cae en la ejecución siguiente. Se ejecuta al arrancar y cada
 * 24 h (`arrancarPurga`, desde `instrumentation.ts`), sin bloquear el arranque y sin que un fallo
 * lo tumbe: se registra y se sigue.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export const DIAS_DE_MARGEN = 30;
export const FILAS_POR_LOTE = 1000;
export const MAX_PASADAS = 20;
export const CADA_MS = 24 * 60 * 60 * 1000;

const DIA_MS = 24 * 60 * 60 * 1000;

export interface ResultadoDeLaPurga {
    sesiones: number;
    refreshTokens: number;
}

/** Cualquier tabla con `id` y `expiresAt`: se borra por lotes lo que caducó antes de `corte`. */
async function purgarTabla(
    tabla: {
        findMany(a: { where: { expiresAt: { lt: Date } }; select: { id: true }; take: number }): Promise<Array<{ id: string }>>;
        deleteMany(a: { where: { id: { in: string[] }; expiresAt: { lt: Date } } }): Promise<{ count: number }>;
    },
    corte: Date,
): Promise<number> {
    let borradas = 0;
    for (let pasada = 0; pasada < MAX_PASADAS; pasada++) {
        const lote = await tabla.findMany({ where: { expiresAt: { lt: corte } }, select: { id: true }, take: FILAS_POR_LOTE });
        if (lote.length === 0) break;
        // El `expiresAt` se repite en el borrado: si entre una consulta y otra alguien alargó la fila, no se toca.
        const { count } = await tabla.deleteMany({ where: { id: { in: lote.map((f) => f.id) }, expiresAt: { lt: corte } } });
        borradas += count;
        if (lote.length < FILAS_POR_LOTE) break;
    }
    return borradas;
}

/** Borra las sesiones y los refresh que caducaron hace más de `DIAS_DE_MARGEN` días. Lanza si la base falla. */
export async function purgarCaducadas(): Promise<ResultadoDeLaPurga> {
    const corte = new Date(Date.now() - DIAS_DE_MARGEN * DIA_MS);
    const sesiones = await purgarTabla(prisma.session, corte);
    const refreshTokens = await purgarTabla(prisma.refreshToken, corte);
    return { sesiones, refreshTokens };
}

declare global {
    var __procovarPurgaProgramada: ReturnType<typeof setInterval> | undefined;
}

let purgando = false;

/** Una pasada que NUNCA lanza: registra el resultado o el fallo. */
export async function purgarYRegistrar(): Promise<void> {
    if (purgando) return; // una purga lenta no se solapa con la siguiente
    purgando = true;
    try {
        const r = await purgarCaducadas();
        logger.info('[purga] caducadas borradas', { ...r });
    } catch (e) {
        logger.warn('[purga] no se pudo purgar lo caducado (se reintenta en la próxima ejecución)', { error: (e as Error).message });
    } finally {
        purgando = false;
    }
}

/**
 * Programa la purga: una ahora (sin esperarla) y otra cada 24 h. Idempotente por proceso.
 * El reloj lleva `unref()`: no impide apagar el proceso.
 */
export function arrancarPurga(): void {
    if (globalThis.__procovarPurgaProgramada) return;
    void purgarYRegistrar();
    const reloj = setInterval(() => void purgarYRegistrar(), CADA_MS);
    reloj.unref?.();
    globalThis.__procovarPurgaProgramada = reloj;
}

/** Para las pruebas: apaga el reloj y permite programar de nuevo. */
export function detenerPurga(): void {
    clearInterval(globalThis.__procovarPurgaProgramada);
    globalThis.__procovarPurgaProgramada = undefined;
}
