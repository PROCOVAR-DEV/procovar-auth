/**
 * «Dispositivos y sesiones» de Mi cuenta: qué sesiones tiene abiertas una persona y cómo
 * cerrarlas. Todo lo que decide algo vive aquí, en funciones puras (sin Prisma ni Next), para
 * poder probarlo de verdad; la ruta `/api/user/sesiones` sólo trae los datos y llama a esto.
 *
 * ## Dos clases de sesión, y el alcance lo decide la CLASE, no el hardware (Jose, 08/10/2026)
 *
 *  - **Navegador**: la sesión que abre el login web (aunque sea el navegador de un teléfono).
 *    Cerrarla avisa con alcance `web`.
 *  - **Dispositivo de Reparto**: la que abre `POST /api/auth/token` para la APK o el escritorio.
 *    Se reconoce SÓLO porque lleva un `refresh_token` ligado (`sessionId`). El `clientId`
 *    `delivery-apk` que ese endpoint también le pone NO cuenta: una sesión web puede nacer con
 *    cualquier `clientId` (la cookie `qb.flow_state` no va firmada) y no por eso es un aparato.
 *    Cerrarlo es cerrar SU familia de refresh (`cerrarFamilia`) y su sesión: no publica nada, y
 *    no toca ni las webs ni los demás aparatos.
 *
 * «Cerrar las demás» y «cerrar en todos los dispositivos» son cortes de seguridad: pasan por
 * `revoke-other-sessions` / `revoke-sessions` de better-auth y su aviso `todo` sale de
 * `hooks-de-sesion.ts`. Esto NO publica nada a mano: si lo hiciera, el aviso saldría dos veces.
 */
import { partesDelAgente } from '@/lib/desde-donde';

/**
 * El mismo valor que `CLIENTE_POR_DEFECTO` de `apk-tokens.ts`. No se importa para que este
 * módulo siga sin dependencias; la prueba comprueba que no se separen. Sólo sirve para NO
 * aceptarlo desde la cookie de flujo (`auth.ts`); no decide qué es un aparato.
 */
export const CLIENTE_DE_APARATOS = 'delivery-apk';

export type TipoDeSesion = 'navegador' | 'aparato';

/** Lo que se lee de la tabla `session`. Sin el `token`: ese no sale nunca hacia el navegador. */
export interface SesionDeBD {
    id: string;
    userId: string;
    clientId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
}

/** Lo que ve la pantalla. Fechas en ISO: viaja por JSON. */
export interface FilaDeSesion {
    id: string;
    tipo: TipoDeSesion;
    /** «Chrome»… Marcas: no se traducen. Null si el agente no lo dice. */
    navegador: string | null;
    sistema: string | null;
    ip: string | null;
    entroEl: string;
    ultimaActividad: string;
    /** La sesión desde la que se hace la petición. */
    actual: boolean;
}

/** Revocada a mano (`revokedAt`) o caducada: no sale en la lista ni se puede «cerrar». */
export const estaActiva = (s: Pick<SesionDeBD, 'revokedAt' | 'expiresAt'>, ahora: Date): boolean =>
    !s.revokedAt && s.expiresAt.getTime() > ahora.getTime();

/**
 * Navegador, o dispositivo de Reparto: sólo un refresh ligado a la sesión (`conRefresh`) hace
 * aparato. Nunca el `clientId`, que en una sesión web se puede falsificar.
 */
export function tipoDeSesion(args: { conRefresh: boolean }): TipoDeSesion {
    return args.conRefresh ? 'aparato' : 'navegador';
}

/** Hay otra sesión además de la actual: lo que habilita «Cerrar las demás». */
export const hayOtras = (filas: readonly Pick<FilaDeSesion, 'actual'>[]): boolean => filas.some((f) => !f.actual);

/** `t` de next-intl, reducido a lo que hace falta aquí (para poder probarlo con un traductor real). */
export type Traductor = (clave: string, valores?: Record<string, string | number>) => string;

/** Un aparato se llama «App de Reparto» (su agente no suele decir más: ver `agente-de-usuario.ts`). */
export function nombreDeFila(f: Pick<FilaDeSesion, 'tipo' | 'navegador' | 'sistema'>, t: Traductor): string {
    if (f.tipo === 'aparato') return f.sistema ? t('appEn', { sistema: f.sistema }) : t('app');
    return f.navegador && f.sistema
        ? t('nombre', { navegador: f.navegador, sistema: f.sistema })
        : (f.navegador ?? f.sistema ?? t('sinNombre'));
}

/**
 * Lo que dice el botón de cerrar de una fila. El nombre accesible CONTIENE el texto visible
 * (WCAG 2.5.3, «etiqueta en el nombre»): quien dicta «pulsar cerrar esta sesión» lo encuentra.
 */
export function textosDelBoton(
    f: Pick<FilaDeSesion, 'tipo' | 'navegador' | 'sistema'>,
    t: Traductor,
): { visible: string; aria: string } {
    const visible = t(f.tipo === 'aparato' ? 'cerrarEsteAparato' : 'cerrarEsta');
    return { visible, aria: `${visible}: ${nombreDeFila(f, t)}` };
}

/**
 * «Salir» de la web. Sólo se va a la entrada si `signOut` NO devolvió `error` (el cliente de
 * better-auth no lanza: devuelve `{ error }`): si falló, la sesión sigue abierta y quien pulsó
 * tiene que enterarse, no encontrarse en la entrada creyendo que salió. Devuelve si salió.
 */
export async function salirDeLaWeb(
    signOut: () => Promise<{ error?: unknown } | null | undefined | void>,
    irALaEntrada: () => void,
): Promise<boolean> {
    try {
        const r = await signOut();
        if (r && r.error) return false;
    } catch {
        return false;
    }
    irALaEntrada();
    return true;
}

/**
 * Las filas de ESTA persona: sus sesiones activas, la actual la primera y luego por actividad.
 * Filtra por `userId` aunque la consulta ya lo haga: es la última barrera antes de la pantalla.
 */
export function filasDeSesiones(
    sesiones: readonly SesionDeBD[],
    ctx: {
        userId: string;
        /** El `id` de la sesión de la petición, resuelto en el servidor. */
        sesionActualId: string | null;
        /**
         * Las sesiones con refresh ligado (las de la APK y el escritorio) y cuándo se renovó
         * por última vez su familia: ésa es su «última actividad».
         */
        renovaciones: ReadonlyMap<string, Date>;
        ahora: Date;
    },
): FilaDeSesion[] {
    return sesiones
        .filter((s) => s.userId === ctx.userId && estaActiva(s, ctx.ahora))
        .map((s): FilaDeSesion => {
            const { navegador, sistema } = partesDelAgente(s.userAgent);
            const renovada = ctx.renovaciones.get(s.id);
            const tipo = tipoDeSesion({ conRefresh: renovada !== undefined });
            return {
                id: s.id,
                tipo,
                navegador,
                sistema,
                ip: s.ipAddress?.trim() || null,
                entroEl: s.createdAt.toISOString(),
                ultimaActividad: (tipo === 'aparato' && renovada ? renovada : s.updatedAt).toISOString(),
                actual: s.id === ctx.sesionActualId,
            };
        })
        .sort(
            (a, b) =>
                Number(b.actual) - Number(a.actual) ||
                b.ultimaActividad.localeCompare(a.ultimaActividad) ||
                a.id.localeCompare(b.id),
        );
}

/**
 * ¿Puede esta persona cerrar ESA sesión? Sólo si es suya y sigue activa; si no, «no existe»
 * (404, no 403: no se confirma que el id sea de otra persona). Cerrar la actual por aquí
 * tampoco: eso es «salir», y sale por `sign-out` (alcance web), no por una revocación.
 * Dice además por qué camino se cierra: un aparato por su familia, un navegador por better-auth.
 */
export function autorizarRevocar(
    userId: string,
    objetivo: (Pick<SesionDeBD, 'id' | 'userId' | 'clientId' | 'revokedAt' | 'expiresAt'> & { token: string; conRefresh: boolean }) | null,
    sesionActualId: string | null,
    ahora: Date,
):
    | { ok: true; via: TipoDeSesion; token: string }
    | { ok: false; estado: 404 | 409; error: 'no_encontrada' | 'es_la_actual' } {
    if (!objetivo || objetivo.userId !== userId || !estaActiva(objetivo, ahora)) {
        return { ok: false, estado: 404, error: 'no_encontrada' };
    }
    if (objetivo.id === sesionActualId) return { ok: false, estado: 409, error: 'es_la_actual' };
    return { ok: true, via: tipoDeSesion(objetivo), token: objetivo.token };
}

export type Orden = { accion: 'una'; id: string } | { accion: 'otras' } | { accion: 'todas' };

/** Los caminos que cierran. En producción: `auth.api` más `cerrarAparato` (la familia de refresh). */
export interface CaminosDeRevocacion {
    revokeSession(a: { headers: Headers; body: { token: string } }): Promise<unknown>;
    revokeOtherSessions(a: { headers: Headers }): Promise<unknown>;
    revokeSessions(a: { headers: Headers }): Promise<unknown>;
    /**
     * Cierra UN aparato: su familia de refresh y su sesión. No publica nada. Devuelve `false` si no
     * había familia que cerrar (la fila de refresh desapareció): entonces no se ha tocado nada.
     */
    cerrarAparato(sesionId: string): Promise<boolean>;
}

export type Resultado = { ok: true } | { ok: false; estado: 404 | 409; error: string };

/**
 * Ejecuta una orden SOLO sobre las sesiones de `actor.userId`.
 *
 * `otras` y `todas` no llevan id: better-auth saca a la persona de la cookie. `una` lleva el
 * id de una fila y se comprueba aquí antes de tocar nada — better-auth, ante un token ajeno,
 * no hace nada y contesta 200 (y `cerrarAparato` no sabe de quién es lo que cierra).
 */
export async function revocar(
    api: CaminosDeRevocacion,
    headers: Headers,
    actor: { userId: string; sesionId: string | null },
    orden: Orden,
    buscar: (id: string) => Promise<(SesionDeBD & { token: string; conRefresh: boolean }) | null>,
    ahora: Date = new Date(),
): Promise<Resultado> {
    if (orden.accion === 'otras') {
        await api.revokeOtherSessions({ headers });
        return { ok: true };
    }
    if (orden.accion === 'todas') {
        await api.revokeSessions({ headers });
        return { ok: true };
    }
    const permiso = autorizarRevocar(actor.userId, await buscar(orden.id), actor.sesionId, ahora);
    if (!permiso.ok) return permiso;
    // Sin familia que cerrar, la sesión se borra por better-auth, que además avisa según su clase real.
    if (permiso.via === 'aparato' && (await api.cerrarAparato(orden.id))) return { ok: true };
    await api.revokeSession({ headers, body: { token: permiso.token } });
    return { ok: true };
}
