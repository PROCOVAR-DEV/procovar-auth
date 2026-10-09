/**
 * Avisar a las aplicaciones cuando better-auth cierra sesiones.
 *
 * Todas las salidas pasan por aquí, vengan de donde vengan: el botón del navegador
 * (`authClient.signOut()` → `POST /api/auth/sign-out`), las tres llamadas a
 * `auth.api.signOut` del servidor (`logout-fanout`, la acción de `(base)/logout`, `auth.server`)
 * y los puntos de «cerrar las demás sesiones». Engancharlo en cada llamador dejaría fuera el
 * primero, que es justo el más usado, y publicaría dos veces en los otros.
 *
 * Es un par antes/después porque al terminar `sign-out` la sesión ya no existe y no hay a quién
 * preguntarle de quién era: en `before` se lee la persona, en `after` se publica — y sólo si la
 * llamada no acabó en error.
 */
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { publicarSesionCerrada, type MotivoDeEvento } from '@/lib/eventos-de-sesion';
import { tipoDeSesion } from '@/lib/sesiones-de-la-persona';
import { cerrarTodasLasFamiliasDe } from '@/lib/apk-tokens';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const SALIDAS = new Set(['/sign-out', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions']);

/** Quién es la persona de esta llamada y con qué motivo se avisará. Se cuelga del `context`, que es el mismo en before y after. */
const personaDe = new WeakMap<object, { userId: string; motivo: MotivoDeEvento }>();

/**
 * A quién le están cambiando o restableciendo la contraseña. Aparte de `personaDe`: un cambio SIN
 * `revokeOtherSessions` no avisa a nadie, pero los refresh de la APK y del escritorio se cierran siempre.
 */
const contrasenaDe = new WeakMap<object, string>();

/**
 * `/revoke-session` cierra UNA sesión, y avisar «de la persona» lo cerraba todo (alcance `todo`:
 * un clic en un navegador echaba al teléfono). Ahora depende de qué sesión es:
 *
 *  - **de un aparato** (lleva un `refresh_token` ligado; el `clientId` NO cuenta, se puede falsificar
 *    desde `qb.flow_state`): no se avisa de nada. Un aparato se cierra por su
 *    familia de refresh (`cerrarFamilia`) y sin tocar a los demás; el aviso `todo` es el corte de
 *    seguridad, no esto.
 *  - **web**: `logout`, o sea alcance `web`.
 *  - **ajena o inexistente**: better-auth no hace nada y contesta 200, así que tampoco hay qué avisar.
 *
 * `/revoke-sessions` y `/revoke-other-sessions` siguen siendo `revocada` (`todo`).
 */
async function motivoDeRevocarUna(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0], userId: string) {
    const token = (ctx.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string') return null;
    try {
        const encontrada = await ctx.context.internalAdapter.findSession(token);
        const sesion = encontrada?.session as { id: string; userId: string } | undefined;
        if (!sesion || sesion.userId !== userId) return null;
        const refresh = await prisma.refreshToken.findFirst({ where: { sessionId: sesion.id }, select: { id: true } });
        return tipoDeSesion({ conRefresh: !!refresh }) === 'aparato' ? null : ('logout' as const);
    } catch (e) {
        // Sin aviso, pero no en silencio: las demás aplicaciones se quedan sin enterarse. Sin id ni token en el registro.
        logger.warn('[hooks-de-sesion] no se pudo clasificar la sesión que se cierra; no se avisa', {
            error: e instanceof Error ? e.name : 'desconocido',
            codigo: (e as { code?: unknown } | null)?.code,
        });
        return null;
    }
}

export const cerrarSesionesAntes = createAuthMiddleware(async (ctx) => {
    // Las ~25 rutas del servidor que llaman a `auth.api.getSession` leen SIEMPRE la base: la caché de la cookie
    // (`qb.session_data`) no se entera de una sesión cerrada y dejaba pasar a quien se había robado un navegador.
    // Por HTTP (el cliente de better-auth, con `ctx.request`) se queda la caché de 60 s.
    if (ctx.path === '/get-session' && !ctx.request) return { context: { query: { disableCookieCache: true } } };
    // Restablecer la contraseña (`revokeSessionsOnPasswordReset: true`) cierra TODAS las sesiones de la
    // cuenta. Quien lo hace no está dentro, así que la persona sale del token del enlace (la verificación
    // `reset-password:<token>` guarda su id). Con el token inválido o caducado la llamada falla y no se avisa.
    if (ctx.path === '/reset-password') {
        // `||` y no `??`, como better-auth: con `body.token = ""` (vacío) vale el de la query, y aquí también.
        const token = (ctx.body as { token?: unknown } | undefined)?.token || (ctx.query as { token?: unknown } | undefined)?.token;
        const v = typeof token === 'string'
            ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`).catch(() => null)
            : null;
        if (v && v.expiresAt >= new Date()) {
            personaDe.set(ctx.context, { userId: v.value, motivo: 'revocada' });
            contrasenaDe.set(ctx.context, v.value);
        }
        return;
    }
    const revocaLasDemas = (ctx.body as { revokeOtherSessions?: unknown } | undefined)?.revokeOtherSessions === true;
    if (!SALIDAS.has(ctx.path) && ctx.path !== '/change-password') return;
    const sesion = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]).catch(() => null);
    const userId = sesion?.user.id;
    if (!userId) return;
    if (ctx.path === '/change-password') contrasenaDe.set(ctx.context, userId);
    const motivo: MotivoDeEvento | null =
        ctx.path === '/sign-out'
            ? 'logout'
            : ctx.path === '/revoke-session'
              ? await motivoDeRevocarUna(ctx, userId)
              : ctx.path === '/change-password' && !revocaLasDemas
                ? null // cambiar la clave sin cerrar las demás sesiones: nada que avisar
                : 'revocada';
    if (motivo) personaDe.set(ctx.context, { userId, motivo });
});

export const cerrarSesionesDespues = createAuthMiddleware(async (ctx) => {
    const aviso = personaDe.get(ctx.context);
    personaDe.delete(ctx.context);
    const conContrasena = contrasenaDe.get(ctx.context);
    contrasenaDe.delete(ctx.context);
    if (ctx.context.returned instanceof Error) return; // la llamada falló: no se cerró nada
    if (conContrasena) {
        // La clave cambió: los refresh de la APK y del escritorio no pueden sobrevivirle. Si falla, la clave YA cambió.
        await cerrarTodasLasFamiliasDe(conContrasena).catch((e) =>
            logger.error('[hooks-de-sesion] no se pudieron cerrar los refresh tras cambiar la contraseña', {
                userId: conContrasena,
                error: e instanceof Error ? e.name : 'desconocido',
            }),
        );
    }
    if (aviso) await publicarSesionCerrada([aviso.userId], aviso.motivo);
});
