/**
 * EL REGISTRO CENTRAL DE DISPOSITIVOS — `docs/dispositivos.md` (29/10/2026).
 *
 * Accesos guarda QUIÉN Y QUÉ es cada aparato (persona, aplicación, plataforma, versión ACTUAL, equipo, sucursal, última
 * vez visto) y lo que el aparato informa de sí mismo (estado de trabajo). Lo que HIZO —su cola, sus rechazos— lo guarda
 * cada aplicación en su base.
 *
 * LA REGLA QUE MANDA AQUÍ: **nada de esto puede romper el login ni la renovación.** `/api/auth/refresh` es la puerta de
 * un logístico con el trabajo del día dentro del teléfono: un fallo del registro no puede salir como 401 ni como 500.
 * Por eso `registrarDispositivo` NUNCA lanza (devuelve `false` y lo deja en el registro) y `dispositivoBloqueado` falla
 * ABIERTO (si no se puede comprobar, se deja pasar). Bloquear es un acto deliberado de un administrador, no un efecto
 * secundario de una caída.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { conTope } from '@/lib/con-tope';
import { _hashDe } from '@/lib/apk-tokens';

/**
 * UUID **v7** (Jose, 29/10/2026: «no uuidv4, uuid7»; es el que ya genera Accesos y el que el CRM ya guarda como id de su
 * instalación). `X-Aparato-Id` identifica, no autentica: solo se exige que sea un v7 bien formado. Un v4 no se registra.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Cualquier UUID bien formado. Solo para lo que YA EXISTE: el aparato que una aplicación importó con su id anterior
 * (el CRM tenía uno v4, de antes del cambio a v7) sigue identificándose con ese id; uno NUEVO tiene que ser v7.
 */
const UUID_CUALQUIERA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const esUuidV7 = (id: string): boolean => UUID.test(id);
export const esUuidCualquiera = (id: string): boolean => UUID_CUALQUIERA.test(id);

const MAX_EQUIPO = 80;
const MAX_ERROR = 200;
const MAX_UA = 300;

/** Recorta y limpia un texto que viene de fuera: sin controles, sin espacios de más, `null` si queda vacío. */
export function limpiarTexto(valor: unknown, max: number): string | null {
    if (typeof valor !== 'string') return null;
    const t = valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

/** La huella: sha256 en hexadecimal (64 minúsculas). Cualquier otra cosa se ignora: nunca rompe la petición. */
const HUELLA = /^[0-9a-f]{64}$/;
export const esHuella = (h: string): boolean => HUELLA.test(h);

export interface CabecerasDeAparato {
    aparatoId: string | null;
    /** `X-Aparato-Huella`: lo que une las instalaciones (Reparto, CRM…) de un mismo aparato físico. Solo agrupa la vista. */
    huella: string | null;
    /** `true` si es un UUID v7: solo con v7 se puede CREAR un aparato; uno que no lo es solo vale si ya existe. */
    esV7: boolean;
    equipo: string | null;
}

/** `X-Aparato-Id` (un UUID) y `X-Aparato-Nombre`. Sin id bien formado no hay registro: el aparato sigue funcionando igual. */
export function leerCabecerasDeAparato(cabeceras: Headers): CabecerasDeAparato {
    const id = (cabeceras.get('x-aparato-id')?.trim() ?? '').toLowerCase();
    const bien = UUID_CUALQUIERA.test(id);
    const h = (cabeceras.get('x-aparato-huella')?.trim() ?? '').toLowerCase();
    return {
        aparatoId: bien ? id : null,
        huella: HUELLA.test(h) ? h : null,
        esV7: bien && UUID.test(id),
        equipo: limpiarTexto(cabeceras.get('x-aparato-nombre'), MAX_EQUIPO),
    };
}

export interface PartesDelAgente {
    aplicacion: string | null;
    version: string | null;
    plataforma: string | null;
}

/** `ProcovarReparto/1.0.47 (Windows)` → { aplicacion: 'ProcovarReparto', version: '1.0.47', plataforma: 'Windows' }. */
export function partesDelAgente(ua: string | null | undefined): PartesDelAgente {
    const m = /^([A-Za-z][\w.-]{0,40})\/([\w.+-]{1,32})\s*\(([^)]{1,40})\)/.exec((ua ?? '').trim());
    if (!m) return { aplicacion: null, version: null, plataforma: null };
    return { aplicacion: m[1], version: m[2], plataforma: m[3].trim() };
}

export interface DelToken {
    sub: string;
    azp: string;
    sucursal: string | null;
}

/**
 * Lo que dice un token de acceso que ACABAMOS DE FIRMAR nosotros (la respuesta de `/refresh` o de `/token`). No se
 * verifica la firma: es nuestro, acaba de salir de aquí. Para un token que llega de fuera, `verifyJwt`.
 */
export function delTokenRecienFirmado(token: string): DelToken | null {
    try {
        const carga = token.split('.')[1];
        if (!carga) return null;
        const p = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof p.sub !== 'string' || typeof p.azp !== 'string') return null;
        const s = typeof p.sucursal === 'string' && p.sucursal ? p.sucursal : null;
        return { sub: p.sub, azp: p.azp, sucursal: s };
    } catch {
        return null;
    }
}

export interface DatosDeRegistro {
    userId: string;
    clientId: string;
    aparatoId: string;
    /** La huella del aparato físico, si la instalación la mandó. */
    huella?: string | null;
    equipo: string | null;
    sucursal: string | null;
    ip: string | null;
    userAgent: string | null;
    familyId: string | null;
}

/**
 * Crea o actualiza la fila del aparato. Va a CADA renovación, así que la versión y la plataforma son siempre las de
 * ahora. **No lanza**: devuelve si se pudo, y si no, deja una línea en el registro.
 */
export async function registrarDispositivo(d: DatosDeRegistro): Promise<boolean> {
    try {
        const { version, plataforma } = partesDelAgente(d.userAgent);
        const ahora = new Date();
        // 1) LA INSTALACIÓN (su `X-Aparato-Id` es único por aplicación) y 2) EL APARATO FÍSICO al que pertenece: el que ya tenía, o el
        // que tiene su huella (así Reparto y el CRM de una misma tablet acaban en UN aparato), o uno nuevo.
        const instalacion = await prisma.dispositivoApp.findUnique({
            where: { clientId_aparatoId: { clientId: d.clientId, aparatoId: d.aparatoId } },
            select: { id: true, dispositivoId: true },
        });
        const dueno = d.huella ? await prisma.dispositivo.findUnique({ where: { huella: d.huella }, select: { id: true } }) : null;

        let dispositivoId = instalacion?.dispositivoId ?? null;
        if (instalacion && dueno && dueno.id !== instalacion.dispositivoId) {
            // La huella ya era de OTRO aparato: esta instalación se une a él, y el que dejó, si se queda vacío, se va.
            await prisma.dispositivoApp.update({ where: { id: instalacion.id }, data: { dispositivoId: dueno.id } });
            await prisma.dispositivo.deleteMany({ where: { id: instalacion.dispositivoId, apps: { none: {} } } });
            dispositivoId = dueno.id;
        }
        // Los datos del aparato: el nombre que le puso el aparato solo se pisa si trae uno; el de un administrador (`nombre`) no se toca.
        const delAparato = {
            ...(plataforma ? { plataforma } : {}),
            ...(d.equipo ? { equipo: d.equipo } : {}),
            ipUltima: d.ip,
            userAgent: limpiarTexto(d.userAgent, MAX_UA),
            vistoAt: ahora,
        };
        if (!dispositivoId) {
            dispositivoId =
                dueno?.id ??
                (await prisma.dispositivo.create({ data: { huella: d.huella ?? null, primeraVez: ahora, ...delAparato }, select: { id: true } })).id;
        }
        const aparato = await prisma.dispositivo.update({ where: { id: dispositivoId }, data: delAparato, select: { id: true, huella: true } });
        // Una huella nueva solo se anota si el aparato aún no tiene una (no se pisa la de una unión hecha a mano).
        if (d.huella && !aparato.huella) {
            await prisma.dispositivo.updateMany({ where: { id: aparato.id, huella: null }, data: { huella: d.huella } }).catch(() => undefined);
        }
        // `userId` es la ÚLTIMA cuenta que entró en esta aplicación; TODAS quedan anotadas en `DispositivoPersona` (abajo).
        const enApp = await prisma.dispositivoApp.upsert({
            where: { clientId_aparatoId: { clientId: d.clientId, aparatoId: d.aparatoId } },
            create: { dispositivoId: aparato.id, clientId: d.clientId, aparatoId: d.aparatoId, userId: d.userId, sucursal: d.sucursal, version, primeraVez: ahora, vistoAt: ahora, ...(d.familyId ? { familyId: d.familyId } : {}) },
            update: { userId: d.userId, sucursal: d.sucursal, version, vistoAt: ahora, ...(d.familyId ? { familyId: d.familyId } : {}) },
            select: { id: true },
        });
        // QUÉ CUENTA entró en este aparato: un mismo PC lo usan varias personas y todas tienen que quedar (Jose, 29/10/2026).
        await prisma.dispositivoPersona.upsert({
            where: { dispositivoAppId_userId: { dispositivoAppId: enApp.id, userId: d.userId } },
            create: { dispositivoAppId: enApp.id, userId: d.userId, sucursal: d.sucursal, version, primeraVez: ahora, vistoAt: ahora },
            update: { sucursal: d.sucursal, version, vistoAt: ahora },
        });
        return true;
    } catch (e) {
        logger.warn('[dispositivos] no se pudo registrar el aparato; el login sigue', {
            error: (e as Error).message,
            clientId: d.clientId,
        });
        return false;
    }
}

/** ¿Un administrador bloqueó este aparato? Falla ABIERTO: si no se puede mirar, no se bloquea a nadie por una caída. */
export async function dispositivoBloqueado(clientId: string, aparatoId: string): Promise<boolean> {
    try {
        const fila = await prisma.dispositivoApp.findFirst({
            where: { clientId, aparatoId },
            select: { bloqueadoAt: true },
        });
        return !!fila?.bloqueadoAt;
    } catch (e) {
        logger.warn('[dispositivos] no se pudo comprobar el bloqueo; se deja pasar', { error: (e as Error).message });
        return false;
    }
}

/**
 * ¿Un administrador bloqueó este `X-Aparato-Id` EN ESTA APLICACIÓN? Se mira ANTES de gastar un refresh: un aparato bloqueado
 * recibe el 401 de siempre («sesión muerta») y la app limpia y vuelve a la puerta. El bloqueo es POR APLICACIÓN (un mismo
 * teléfono puede tener Reparto y CRM): el del CRM no deja sin entrar a Reparto. Falla ABIERTO.
 */
export async function aparatoBloqueado(cabeceras: Headers, clientId: string | null): Promise<boolean> {
    const { aparatoId } = leerCabecerasDeAparato(cabeceras);
    if (!aparatoId || !clientId) return false;
    try {
        const fila = await conTope(
            prisma.dispositivoApp.findFirst({
                where: { clientId, aparatoId, bloqueadoAt: { not: null } },
                select: { id: true },
            }),
            1500
        );
        return !!fila;
    } catch (e) {
        logger.warn('[dispositivos] no se pudo comprobar el bloqueo; se deja pasar', { error: (e as Error).message });
        return false;
    }
}

/** Igual, pero la aplicación sale del refresh que llega (`/refresh` no la dice). Sin `X-Aparato-Id` no gasta ni una consulta. */
export async function aparatoBloqueadoPorRefresh(refresh: string, cabeceras: Headers, clientePorDefecto: string): Promise<boolean> {
    if (!leerCabecerasDeAparato(cabeceras).aparatoId) return false;
    try {
        const fila = await conTope(
            prisma.refreshToken.findUnique({ where: { tokenHash: _hashDe(refresh) }, select: { clientId: true } }),
            1500
        );
        if (!fila) return false;
        return aparatoBloqueado(cabeceras, fila.clientId ?? clientePorDefecto);
    } catch (e) {
        logger.warn('[dispositivos] no se pudo comprobar el bloqueo; se deja pasar', { error: (e as Error).message });
        return false;
    }
}

/**
 * Anota el aparato que acaba de recibir un par de tokens. Se llama DESPUÉS de emitirlo, con las cabeceras de la
 * petición: la persona, la aplicación y la sucursal salen del token recién firmado (nada se fía de lo que diga el
 * cliente), la cadena de refresh de la fila del refresh nuevo. **Nunca lanza y nunca espera más de 1,5 s.**
 */
export async function registrarDelPar(
    par: { token: string; refresh_token: string },
    cabeceras: Headers,
    aparato: { ip?: string | null; userAgent?: string | null }
): Promise<void> {
    try {
        const { aparatoId, esV7, equipo, huella } = leerCabecerasDeAparato(cabeceras);
        if (!aparatoId) return;
        const t = delTokenRecienFirmado(par.token);
        if (!t) return;
        await conTope(
            (async () => {
                // Un id que no es v7 NO crea nada: solo vale si el aparato ya estaba (importado con su id de antes).
                if (!esV7) {
                    const existe = await prisma.dispositivoApp.findUnique({
                        where: { clientId_aparatoId: { clientId: t.azp, aparatoId } },
                        select: { id: true },
                    });
                    if (!existe) return;
                }
                const fila = await prisma.refreshToken
                    .findUnique({ where: { tokenHash: _hashDe(par.refresh_token) }, select: { familyId: true } })
                    .catch(() => null);
                await registrarDispositivo({
                    userId: t.sub,
                    clientId: t.azp,
                    aparatoId,
                    huella,
                    equipo,
                    sucursal: t.sucursal,
                    ip: aparato.ip ?? null,
                    userAgent: aparato.userAgent ?? null,
                    familyId: fila?.familyId ?? null,
                });
            })(),
            1500
        );
    } catch (e) {
        logger.warn('[dispositivos] no se pudo anotar el aparato; la renovación sigue', { error: (e as Error).message });
    }
}

/** El cuerpo de `POST /api/dispositivos/estado`, ya limpio. Un campo ausente NO borra el valor anterior. */
export interface EstadoInformado {
    ultimaDescarga?: Date;
    ultimaSubida?: Date;
    pendientes?: number;
    rechazados?: number;
    ultimoError?: string | null;
}

const hora = (v: unknown): Date | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = Date.parse(v);
    // Ni del futuro lejano ni de antes de que existieran las apps: un reloj roto no ensucia el panel.
    const ahora = Date.now();
    return Number.isFinite(t) && t <= ahora + 5 * 60_000 && t > Date.UTC(2026, 0, 1) ? new Date(t) : undefined;
};

const cuenta = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined;

export function leerEstadoInformado(cuerpo: unknown): EstadoInformado {
    const c = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as Record<string, unknown>;
    const salida: EstadoInformado = {};
    const d = hora(c.ultimaDescarga);
    if (d) salida.ultimaDescarga = d;
    const s = hora(c.ultimaSubida);
    if (s) salida.ultimaSubida = s;
    const p = cuenta(c.pendientes);
    if (p !== undefined) salida.pendientes = p;
    const r = cuenta(c.rechazados);
    if (r !== undefined) salida.rechazados = r;
    // `null` SÍ cuenta: es «ya no hay error». Solo `undefined` es «no dije nada».
    if (c.ultimoError === null) salida.ultimoError = null;
    else if (typeof c.ultimoError === 'string') salida.ultimoError = limpiarTexto(c.ultimoError, MAX_ERROR);
    return salida;
}

export type Marca = 'funciona' | 'atascado' | 'callado' | 'bloqueado' | 'sin_estado';

export interface DeLaMarca {
    vistoAt: Date;
    bloqueadoAt: Date | null;
    ultimaSubida: Date | null;
    pendientes: number | null;
    rechazados: number | null;
    ultimoError: string | null;
    estadoAt: Date | null;
}

/** Cuánto sin verlo es «callado». Con la conexión de Cuba, un día sin señal no es una avería. */
export const HORAS_PARA_CALLADO = 48;
/** Cuánto con pendientes y sin subir es «atascado». */
export const HORAS_PARA_ATASCADO = 6;
/** Un error informado hace más de esto ya no cuenta. */
export const HORAS_DE_UN_ERROR = 24;

/**
 * La marca que se pinta: de un vistazo, ¿funciona?
 *
 *  · `bloqueado`: lo bloqueó un administrador;
 *  · `callado`: no se ve desde hace [HORAS_PARA_CALLADO];
 *  · `atascado`: tiene rechazados, o pendientes sin subir desde hace [HORAS_PARA_ATASCADO], o un error reciente;
 *  · `funciona`: se ve y no tiene nada de lo anterior, y la aplicación informó su estado alguna vez;
 *  · `sin_estado`: se ve, pero la aplicación no informa de su trabajo (todavía): no se dice que funcione.
 */
export function marcaDelDispositivo(d: DeLaMarca, ahora: Date = new Date()): Marca {
    const horas = (desde: Date) => (ahora.getTime() - desde.getTime()) / 3_600_000;
    if (d.bloqueadoAt) return 'bloqueado';
    if (horas(d.vistoAt) >= HORAS_PARA_CALLADO) return 'callado';
    if (!d.estadoAt) return 'sin_estado';
    const sinSubir = d.ultimaSubida ? horas(d.ultimaSubida) : Infinity;
    const errorReciente = !!d.ultimoError && horas(d.estadoAt) < HORAS_DE_UN_ERROR;
    if ((d.rechazados ?? 0) > 0 || ((d.pendientes ?? 0) > 0 && sinSubir >= HORAS_PARA_ATASCADO) || errorReciente) {
        return 'atascado';
    }
    return 'funciona';
}
