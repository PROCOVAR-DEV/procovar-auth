/**
 * Empujar a las aplicaciones lo que Accesos ya sabe: «esta persona dejó de valer».
 *
 * Contrato (el que implementan PEDIDO, Analitics, Rutas, Delivery, AFT, Notify…;
 * explicado entero en `docs/sesion-unica.md`):
 *
 *  - Canal pub/sub `procovar:auth:eventos`, SIN el prefijo de ioredis.
 *  - Mensaje: `{"v":1,"tipo":"sesion-cerrada"|"permisos-cambiados","userIds":[…],"tms":<ms>,
 *    "motivo":…,"alcance":"web"|"todo"}`.
 *  - `alcance`: `logout` cierra sólo la WEB (cookies) de la persona; no corta los dispositivos
 *    nativos (APK, escritorio), que tienen su propio login. Todo lo demás es `todo`.
 *  - Marca de recuperación: ANTES de publicar, `SET procovar:auth:invalida:<alcance>:<userId> <tms>
 *    EX 691200` en la DB de sesiones (6) — pero la marca SÓLO SUBE: un script Lua la escribe si no
 *    existe o si la que hay es menor (un aviso tardío o reintentado no puede hacerla retroceder y
 *    resucitar sesiones). Un evento `web` escribe SOLO la `web`; uno `todo` escribe
 *    la `todo`. Una aplicación que se reinicie o pierda un mensaje reconstruye su estado con
 *    `SCAN procovar:auth:invalida:*`. Regla suya: una sesión web emitida ANTES de `max(web,todo)`
 *    ya no vale; un cliente nativo con bearer, sólo si `todo >= iat`. La persona vuelve a entrar
 *    por Accesos.
 *
 * ## Un fallo de Redis NUNCA rompe la acción que lo origina
 *
 * Quien cierra una sesión, quita un rol o da de baja a alguien ya lo hizo en la base; que el
 * aviso no llegue es un problema de entrega, no de la acción. Por eso nada de aquí lanza: se
 * registra y se sigue, y como mucho se espera `ESPERA_MAX_MS` por Redis. Si el aviso se pierde,
 * la aplicación se entera igualmente cuando la cookie de la persona caduque o cuando la
 * marca llegue a la recarga con SCAN — pero NO por polling: eso es lo que se evita.
 *
 * Para `baja` y `revocada` (acceso que sigue vivo si el aviso se pierde) además se registra en
 * nivel `error` A QUIÉN (ids internos, sin correo ni token) y se reintenta UNA vez a los
 * `REINTENTO_MS`, con el mismo `tms`, sin retrasar la respuesta de quien lo originó.
 */
import type Redis from 'ioredis';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';

export const CANAL_DE_EVENTOS = 'procovar:auth:eventos';
/** 8 días: un poco más que la cookie más larga de una aplicación. */
export const SEGUNDOS_DE_LA_MARCA = 691_200;
export const MAX_IDS_POR_MENSAJE = 500;
/** Lo más que una acción espera a Redis. */
export const ESPERA_MAX_MS = 1000;

export type TipoDeEvento = 'sesion-cerrada' | 'permisos-cambiados';
export type MotivoDeEvento = 'logout' | 'revocada' | 'baja' | 'rol' | 'llaves' | 'admin' | 'membresia';

export type AlcanceDeEvento = 'web' | 'todo';

/** `logout` cierra la web; cualquier otra cosa (revocación explícita, baja, cambio de permisos…) es de todo. */
export const alcanceDe = (motivo: MotivoDeEvento): AlcanceDeEvento => (motivo === 'logout' ? 'web' : 'todo');

export const claveDeMarca = (alcance: AlcanceDeEvento, userId: string) =>
    `procovar:auth:invalida:${alcance}:${userId}`;

declare global {
    var __procovarEventosRedis: Redis | undefined;
}

/**
 * Un cliente aparte, sin `keyPrefix`: el de `getRedis` antepone `REDIS_PREFIX` a las claves y
 * la marca tiene que ser literal para que la lean otras aplicaciones. `duplicate` conserva la
 * DB (6), los centinelas y la contraseña.
 */
function clienteSinPrefijo(): Redis {
    if (!globalThis.__procovarEventosRedis) {
        const c = getRedis('sessions').duplicate({ keyPrefix: '', enableAutoPipelining: false });
        // `duplicate` no copia los oyentes: sin éste, ioredis vuelca la traza entera en cada reconexión.
        c.on('error', (err) => logger.warn('[eventos-de-sesion] redis', { msg: err.message }));
        globalThis.__procovarEventosRedis = c;
    }
    return globalThis.__procovarEventosRedis;
}

/** `SET` con TTL sólo si la marca no existe o la nueva es MAYOR (valor no numérico = se pisa). */
export const MARCA_SOLO_SUBE = `
local a = tonumber(redis.call('GET', KEYS[1]))
if not a or a < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
end
return 1`;

function conLimite<T>(promesa: Promise<T>): Promise<T> {
    promesa.catch(() => {}); // si pierde la carrera, que su rechazo tardío no quede suelto
    let reloj: ReturnType<typeof setTimeout>;
    const limite = new Promise<never>((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error(`Redis no contestó en ${ESPERA_MAX_MS} ms`)), ESPERA_MAX_MS);
    });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

/** Motivos en los que perder el aviso deja a alguien con acceso que ya no debería tener. */
const MOTIVOS_GRAVES = new Set<MotivoDeEvento>(['baja', 'revocada']);
/** Cuánto se espera antes de reintentar un aviso grave. */
export const REINTENTO_MS = 2000;

/** Marcas + mensajes en UN pipeline. Lanza si Redis no contesta o algún comando falla. */
async function enviar(
    tipo: TipoDeEvento,
    ids: readonly string[],
    motivo: MotivoDeEvento,
    tms: number,
): Promise<void> {
    const alcance = alcanceDe(motivo);
    const pipe = clienteSinPrefijo().pipeline();
    for (let i = 0; i < ids.length; i += MAX_IDS_POR_MENSAJE) {
        const lote = ids.slice(i, i + MAX_IDS_POR_MENSAJE);
        // Las marcas van antes que el mensaje: si el mensaje llega, la marca ya está.
        for (const id of lote) pipe.eval(MARCA_SOLO_SUBE, 1, claveDeMarca(alcance, id), String(tms), String(SEGUNDOS_DE_LA_MARCA));
        pipe.publish(CANAL_DE_EVENTOS, JSON.stringify({ v: 1, tipo, userIds: lote, tms, motivo, alcance }));
    }
    // `exec` no rechaza por un comando que falla: devuelve el error dentro del resultado.
    const resultados = (await conLimite(pipe.exec())) ?? [];
    const fallo = resultados.find(([err]) => err);
    if (fallo) throw fallo[0];
}

async function publicar(tipo: TipoDeEvento, userIds: readonly string[], motivo: MotivoDeEvento): Promise<void> {
    const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return;
    const tms = Date.now(); // MILISEGUNDOS
    try {
        await enviar(tipo, ids, motivo, tms);
    } catch (e) {
        const error = (e as Error).message;
        if (!MOTIVOS_GRAVES.has(motivo)) {
            logger.warn('[eventos-de-sesion] no se pudo avisar a las aplicaciones', { tipo, motivo, personas: ids.length, error });
            return;
        }
        // Una baja o una revocación que no llega es acceso que sigue vivo: queda dicho A QUIÉN (ids
        // internos de Accesos; ni correo ni token) y se reintenta una vez sin retrasar la respuesta.
        logger.error('[eventos-de-sesion] aviso GRAVE sin entregar; se reintenta', { tipo, motivo, userIds: ids, error });
        const reintento = setTimeout(() => {
            enviar(tipo, ids, motivo, tms).catch((e2) =>
                logger.error('[eventos-de-sesion] el reintento también falló', {
                    tipo, motivo, userIds: ids, error: (e2 as Error).message,
                }),
            );
        }, REINTENTO_MS);
        reintento.unref?.();
    }
}

/** La sesión de estas personas se cerró: lo emitido antes de ahora ya no vale. */
export const publicarSesionCerrada = (userIds: readonly string[], motivo: MotivoDeEvento) =>
    publicar('sesion-cerrada', userIds, motivo);

/** Sus roles, llaves o sucursales cambiaron: que las aplicaciones vuelvan a preguntarle a Accesos. */
export const publicarPermisosCambiados = (userIds: readonly string[], motivo: MotivoDeEvento) =>
    publicar('permisos-cambiados', userIds, motivo);

/**
 * Todas las personas con este rol, por defecto o por membresía, tal y como están AHORA.
 * Por defecto nunca lanza: si la base falla se devuelve vacío y la acción sigue (el cambio ya está hecho).
 * Antes de BORRAR hay que pasar `{ lanzar: true }`: con la lista vacía el borrado seguiría y no se avisaría
 * a nadie; lanzando, el borrado aborta.
 */
export async function personasConRol(roleId: string, { lanzar = false }: { lanzar?: boolean } = {}): Promise<string[]> {
    try {
        const filas = await prisma.user.findMany({
            where: {
                OR: [{ defaultRoleId: roleId }, { members: { some: { memberRoles: { some: { roleId } } } } }],
            },
            select: { id: true },
        });
        return filas.map((f) => f.id);
    } catch (e) {
        if (lanzar) throw e;
        logger.warn('[eventos-de-sesion] no se pudo listar quién tiene el rol', { error: (e as Error).message });
        return [];
    }
}

/** Las personas de una sucursal, tal y como están AHORA. Nunca lanza, salvo con `{ lanzar: true }` (antes de borrar: ver `personasConRol`). */
export async function personasDeLaSucursal(organizationId: string, { lanzar = false }: { lanzar?: boolean } = {}): Promise<string[]> {
    try {
        const filas = await prisma.member.findMany({ where: { organizationId }, select: { userId: true } });
        return filas.map((f) => f.userId);
    } catch (e) {
        if (lanzar) throw e;
        logger.warn('[eventos-de-sesion] no se pudo listar la sucursal', { error: (e as Error).message });
        return [];
    }
}
