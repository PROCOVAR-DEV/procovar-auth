/**
 * LA LISTA DE DISPOSITIVOS PARA LAS APLICACIONES — `GET /api/service/dispositivos` (docs/dispositivos.md).
 *
 * Accesos es la fuente de la IDENTIDAD del aparato; cada aplicación (el CRM, Reparto…) guarda su ficha local con el MISMO
 * `aparatoId` para sus claves foráneas y su trabajo, y lee de aquí si existe, de quién es, qué versión tiene y si está
 * bloqueado. Todo lo de aquí es puro (sin base) para poder probarlo.
 */

/** Los nombres cortos que usan las aplicaciones → el `clientId` de Accesos. Un valor que ya es un `clientId` pasa tal cual. */
const ALIAS: Record<string, string> = {
    crm: 'crm-apk',
    reparto: 'delivery-apk',
    delivery: 'delivery-apk',
};

export function clienteDeApp(app: string | null | undefined): string | null {
    const a = (app ?? '').trim().toLowerCase();
    if (!a || a.length > 40 || !/^[a-z0-9][a-z0-9-]*$/.test(a)) return null;
    return ALIAS[a] ?? a;
}

/**
 * LA APP SALE DE QUIÉN LLAMA, no de lo que mande (Jose, 29/10/2026: el CRM solo ve los aparatos del CRM). La credencial de
 * servicio lleva en sus `scopes` una entrada `dispositivos:<clientId>` por cada aplicación cuyos aparatos puede ver y
 * gestionar (`dispositivos:crm-apk`). El comodín `*` NO cuenta: ver todos los aparatos es una decisión explícita.
 */
export function appsPermitidas(scopes: readonly string[]): string[] {
    return scopes
        .filter((s) => s.startsWith('dispositivos:'))
        .map((s) => s.slice('dispositivos:'.length))
        .filter((a) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(a));
}

/**
 * La app sobre la que se trabaja: la pedida (`?app=`) si la credencial la permite, la única permitida si no se pidió, o
 * un motivo de rechazo. `?app=reparto` con la credencial del CRM es `app_no_permitida`, no una lista vacía.
 */
export function appDeLaPeticion(
    pedida: string | null | undefined,
    permitidas: readonly string[]
): { ok: true; app: string } | { ok: false; estado: 400 | 403; error: string } {
    if (permitidas.length === 0) return { ok: false, estado: 403, error: 'sin_permiso_de_dispositivos' };
    if (pedida === null || pedida === undefined || pedida.trim() === '') {
        return permitidas.length === 1
            ? { ok: true, app: permitidas[0] }
            : { ok: false, estado: 400, error: 'app_obligatoria' };
    }
    const app = clienteDeApp(pedida);
    if (!app) return { ok: false, estado: 400, error: 'app_invalida' };
    if (!permitidas.includes(app)) return { ok: false, estado: 403, error: 'app_no_permitida' };
    return { ok: true, app };
}

export const LIMITE_POR_DEFECTO = 500;
export const LIMITE_MAXIMO = 2000;

export function limiteDe(crudo: string | null | undefined): number {
    const n = Number(crudo);
    if (!Number.isInteger(n) || n < 1) return LIMITE_POR_DEFECTO;
    return Math.min(n, LIMITE_MAXIMO);
}

/** El cursor es `<updatedAt en ms>.<id>` en base64url: opaco para la aplicación. Orden estable: (updatedAt, id). */
export function codificarCursor(d: { updatedAt: Date; id: string }): string {
    return Buffer.from(`${d.updatedAt.getTime()}.${d.id}`).toString('base64url');
}

export function decodificarCursor(c: string | null | undefined): { updatedAt: Date; id: string } | null {
    if (!c) return null;
    try {
        const t = Buffer.from(c, 'base64url').toString('utf8');
        const i = t.indexOf('.');
        const ms = Number(t.slice(0, i));
        const id = t.slice(i + 1);
        if (!Number.isFinite(ms) || ms <= 0 || !/^[\w-]{1,64}$/.test(id)) return null;
        return { updatedAt: new Date(ms), id };
    } catch {
        return null;
    }
}

export function fechaOpcional(crudo: string | null | undefined): Date | null {
    if (!crudo) return null;
    const t = Date.parse(crudo);
    return Number.isFinite(t) ? new Date(t) : null;
}

export interface FilaDeBD {
    id: string;
    aparatoId: string;
    userId: string;
    clientId: string;
    sucursal: string | null;
    plataforma: string | null;
    version: string | null;
    equipo: string | null;
    nombre: string | null;
    primeraVez: Date;
    vistoAt: Date;
    updatedAt: Date;
    bloqueadoAt: Date | null;
}

export interface DispositivoDeServicio {
    aparatoId: string;
    userId: string;
    app: string;
    sucursal: string | null;
    plataforma: string | null;
    version: string | null;
    /** El que le puso un administrador, o si no el que informó el propio aparato. */
    nombre: string | null;
    estado: 'activo' | 'bloqueado';
    primeraVez: string;
    ultimaVez: string;
    /** Cuándo cambió por última vez esta ficha (para `desde=`). */
    actualizado: string;
}

export function aServicio(d: FilaDeBD): DispositivoDeServicio {
    return {
        aparatoId: d.aparatoId,
        userId: d.userId,
        app: d.clientId,
        sucursal: d.sucursal,
        plataforma: d.plataforma,
        version: d.version,
        nombre: d.nombre ?? d.equipo,
        estado: d.bloqueadoAt ? 'bloqueado' : 'activo',
        primeraVez: d.primeraVez.toISOString(),
        ultimaVez: d.vistoAt.toISOString(),
        actualizado: d.updatedAt.toISOString(),
    };
}
