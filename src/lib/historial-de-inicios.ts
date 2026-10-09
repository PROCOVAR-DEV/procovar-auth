/**
 * «Historial de inicios de sesión» de Mi cuenta: desde dónde y cuándo entró ESTA persona.
 *
 * No hay una tabla nueva: se lee de la auditoría (`audit_log`, índice `[userId, createdAt]`).
 * Todo lo que decide algo vive aquí en funciones puras (sin Prisma ni Next) para poder
 * probarlo; `/api/user/historial` sólo resuelve la persona en el servidor y llama a esto.
 *
 * ## Qué cuenta como «un inicio»
 *
 *  - `auth.signin.web`: la sesión que abre CUALQUIER entrada de better-auth (correo y
 *    contraseña, alta, social…). La escribe `auditarInicioWeb`, enganchado en
 *    `databaseHooks.session.create.after` de `auth.ts`.
 *  - `auth.apk.login`: la APK y el escritorio de Reparto (`POST /api/auth/token`).
 *  - `auth.login`: lo que ya apuntaba la acción de servidor `signIn` ANTES de que existiera el
 *    hook. Sólo se usa para la historia vieja: si hay un `auth.signin.web` de la misma persona
 *    a menos de 30 s, es el mismo inicio contado dos veces y no se cuenta.
 *
 * NO cuentan: `auth.code.exchange` (un inicio SSO silencioso hacia otra aplicación: la
 * persona ya estaba dentro, no inició nada), los intentos fallidos (`auth.apk.login_failed`:
 * ni se guardan con persona ni se enseñan) ni las renovaciones del refresh.
 *
 * El hook también salta cuando la APK abre su sesión (pasa por `signInEmail`): ese
 * `auth.signin.web` lleva el mismo `sessionId` que el `auth.apk.login` (o `auth.apk.denied`)
 * y se descarta, para que el aparato salga una vez y como aparato.
 */
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

export const INICIO_WEB = 'auth.signin.web';
const INICIO_WEB_ANTIGUO = 'auth.login';
const INICIO_APARATO = 'auth.apk.login';
const APARATO_DENEGADO = 'auth.apk.denied'; // sólo para descartar su `auth.signin.web`

/** Lo que se lee de la auditoría. `auth.code.exchange` no está, y no debe estar. */
const ACCIONES_LEIDAS = [INICIO_WEB, INICIO_WEB_ANTIGUO, INICIO_APARATO, APARATO_DENEGADO];

export const POR_PAGINA = 10;
export const TOPE_POR_PAGINA = 50;
export const DIAS_DE_HISTORIAL = 90;
const DIA_MS = 24 * 60 * 60 * 1000;
const MISMO_INICIO_MS = 30_000;
// ponytail: se leen como mucho 500 apuntes de la persona en 90 días y se pagina en memoria
// (así los duplicados que caen a ambos lados de una página se descartan bien). Quien pase
// de 500 inicios en 90 días —una cuenta compartida— pierde los más antiguos; para eso,
// paginar en SQL con un margen de 60 s.
const MAX_LEIDOS = 500;

export interface Apunte {
    id: string;
    userId: string | null;
    action: string;
    ip: string | null;
    ua: string | null;
    createdAt: Date;
    meta: unknown;
}

export interface FilaDeInicio {
    id: string;
    /** ISO: viaja por JSON; la pantalla la pone en la zona y el idioma de quien mira. */
    cuando: string;
    tipo: 'navegador' | 'aparato';
    ip: string | null;
    ua: string | null;
    /**
     * ¿Sigue abierta esa sesión? Se cruza por el `sessionId` del apunte con las sesiones vivas.
     * `null` = no se puede saber (los apuntes de antes del hook no guardaron la sesión): no se inventa.
     */
    estaActiva: boolean | null;
    /** La sesión desde la que se hace la petición. */
    esActual: boolean;
}

export interface PaginaDeInicios {
    filas: FilaDeInicio[];
    /** `desde` de la página siguiente (la fecha del último visto), o null si no hay más. */
    siguiente: string | null;
}

/** 10 por defecto, 50 como máximo, aunque pidan 1000, 0, -3 o «abc». */
export function limiteDePagina(pedido: unknown): number {
    const n = Math.trunc(Number(pedido));
    if (!Number.isFinite(n) || n < 1) return POR_PAGINA;
    return Math.min(n, TOPE_POR_PAGINA);
}

const sesionDe = (meta: unknown): string | null => {
    const id = (meta as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === 'string' && id ? id : null;
};

/**
 * Las filas de ESTA persona, las más recientes primero. Filtra por `userId` aunque la
 * consulta ya lo haga: es la última barrera antes de la pantalla.
 */
export function iniciosDeLaPersona(
    apuntes: readonly Apunte[],
    ctx: {
        userId: string;
        ahora: Date;
        limite?: unknown;
        /** Fecha del último apunte visto: sólo salen los anteriores. */
        desde?: Date | null;
        /** Ids de las sesiones que siguen abiertas ahora. */
        vivas: ReadonlySet<string>;
        sesionActualId?: string | null;
    },
): PaginaDeInicios {
    const limite = limiteDePagina(ctx.limite);
    const corte = ctx.ahora.getTime() - DIAS_DE_HISTORIAL * DIA_MS;
    const propios = apuntes.filter((a) => a.userId === ctx.userId && a.createdAt.getTime() >= corte);

    const deAparato = new Set(
        propios.filter((a) => a.action === INICIO_APARATO || a.action === APARATO_DENEGADO).flatMap((a) => sesionDe(a.meta) ?? []),
    );
    const webs = propios.filter((a) => a.action === INICIO_WEB).map((a) => a.createdAt.getTime());

    const inicios = propios
        .filter((a) => {
            if (a.action === INICIO_APARATO) return true;
            if (a.action === INICIO_WEB) {
                const s = sesionDe(a.meta);
                return !(s && deAparato.has(s));
            }
            if (a.action === INICIO_WEB_ANTIGUO) {
                const t = a.createdAt.getTime();
                return !webs.some((w) => Math.abs(w - t) <= MISMO_INICIO_MS);
            }
            return false; // auth.code.exchange, auth.apk.denied, lo que venga
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));

    const resto = ctx.desde ? inicios.filter((a) => a.createdAt.getTime() < ctx.desde!.getTime()) : inicios;
    const pagina = resto.slice(0, limite);

    return {
        filas: pagina.map((a): FilaDeInicio => {
            const sesion = sesionDe(a.meta);
            return {
                id: a.id,
                cuando: a.createdAt.toISOString(),
                tipo: a.action === INICIO_APARATO ? 'aparato' : 'navegador',
                ip: a.ip?.trim() || null,
                ua: a.ua?.trim() || null,
                estaActiva: sesion ? ctx.vivas.has(sesion) : null,
                esActual: !!sesion && sesion === ctx.sesionActualId,
            };
        }),
        siguiente: resto.length > pagina.length ? pagina[pagina.length - 1].createdAt.toISOString() : null,
    };
}

/**
 * El historial de la persona. `userId` es SIEMPRE el de la sesión del servidor, nunca el de la
 * petición. `db` es para las pruebas.
 */
export async function historialDeInicios(
    userId: string,
    opts: { limite?: unknown; desde?: Date | null; sesionActualId?: string | null; ahora?: Date } = {},
    db: Pick<typeof prisma, 'auditLog' | 'session'> = prisma,
): Promise<PaginaDeInicios> {
    // Sin persona no se consulta: `where: { userId: undefined }` en Prisma sería «todas».
    if (!userId) return { filas: [], siguiente: null };
    const ahora = opts.ahora ?? new Date();

    const [apuntes, vivas] = await Promise.all([
        db.auditLog.findMany({
            where: {
                userId,
                action: { in: ACCIONES_LEIDAS },
                createdAt: { gte: new Date(ahora.getTime() - DIAS_DE_HISTORIAL * DIA_MS) },
            },
            select: { id: true, userId: true, action: true, ip: true, ua: true, createdAt: true, meta: true },
            orderBy: { createdAt: 'desc' },
            take: MAX_LEIDOS,
        }),
        db.session.findMany({
            where: { userId, revokedAt: null, expiresAt: { gt: ahora } },
            select: { id: true },
            take: MAX_LEIDOS,
        }),
    ]);

    return iniciosDeLaPersona(apuntes, {
        userId,
        ahora,
        limite: opts.limite,
        desde: opts.desde,
        vivas: new Set(vivas.map((s) => s.id)),
        sesionActualId: opts.sesionActualId,
    });
}

/**
 * `databaseHooks.session.create.after` de better-auth: deja huella de cada sesión que se abre.
 * Sin token ni cookie: sólo el id de la sesión, la IP y el navegador. Si apuntar falla NO se
 * rompe la entrada (`audit` ya traga sus errores; el `try` cubre lo que lance antes de la
 * consulta): sin historial se entra igual, sin entrar no se tiene historial que mirar.
 */
export function auditarInicioWeb(session: {
    id: string;
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
}): void {
    try {
        audit({
            action: INICIO_WEB,
            userId: session.userId,
            ip: session.ipAddress || null,
            userAgent: session.userAgent || null,
            meta: { sessionId: session.id },
        });
    } catch (e) {
        logger.warn('[historial] no se pudo anotar el inicio de sesión', { error: (e as Error).message });
    }
}
