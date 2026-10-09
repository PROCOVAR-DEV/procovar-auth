/**
 * Lo más que una puerta espera a Redis (limitador, anti-replay). El cliente compartido reintenta
 * ~4 s antes de rendirse —y con los centinelas inalcanzables no rechaza nunca—, y una petición de
 * la APK no puede esperar tanto: pasado este tiempo la operación cuenta como fallida.
 */
export const REDIS_ESPERA_MAX_MS = 800

/** `operacion`, o un rechazo a los `ms`. La operación que pierde la carrera no se cancela. */
export async function conTope<T>(operacion: Promise<T>, ms = REDIS_ESPERA_MAX_MS): Promise<T> {
    let reloj: ReturnType<typeof setTimeout> | undefined
    operacion.catch(() => {}) // si pierde la carrera, su rechazo tardío no queda suelto
    const limite = new Promise<never>((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error(`Redis no contestó en ${ms} ms`)), ms)
    })
    try {
        return await Promise.race([operacion, limite])
    } finally {
        clearTimeout(reloj)
    }
}
