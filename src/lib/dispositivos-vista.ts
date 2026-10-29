/**
 * LO QUE LA PANTALLA «DISPOSITIVOS» ENSEÑA, ya masticado y sin base (para poder probarlo): una fila por aparato, con su marca
 * (funciona / atascado / callado / bloqueado), el nombre de la persona y el enlace a «Ver actividad» de su aplicación.
 */
import { aplicacionDeSesion } from '@/lib/desde-donde';
import { marcaDelDispositivo, type Marca } from '@/lib/dispositivos';

/** Las aplicaciones que siempre tienen pestaña, aunque aún no haya aparatos: así se ve que existen y que falta que informen. */
export const APPS_CON_PESTANA = ['delivery-apk', 'crm-apk'] as const;

/** «Reparto», «CRM»…: el nombre que se lee. Lo que no se conoce sale tal cual. */
const NOMBRES: Record<string, string> = { 'delivery-apk': 'Reparto', 'crm-apk': 'CRM' };

export function nombreDeApp(clientId: string): string {
    const n = NOMBRES[clientId] ?? aplicacionDeSesion(clientId);
    return n;
}

/** Las pestañas: las fijas más cualquier otra aplicación que ya tenga aparatos. Sin repetir y en orden estable. */
export function pestanas(conAparatos: readonly string[]): { clientId: string; nombre: string }[] {
    const otras = [...new Set(conAparatos)].filter((c) => !(APPS_CON_PESTANA as readonly string[]).includes(c)).sort();
    const todas = [...APPS_CON_PESTANA, ...otras];
    return todas.map((clientId) => ({ clientId, nombre: nombreDeApp(clientId) }));
}

/** `https://crm.procovar.cloud/dispositivos/{aparatoId}` + un id → la dirección de «Ver actividad». Solo http(s): nada de `javascript:`. */
export function urlDeActividad(plantilla: string | null | undefined, aparatoId: string): string | null {
    if (!plantilla || !plantilla.includes('{aparatoId}')) return null;
    const url = plantilla.replaceAll('{aparatoId}', encodeURIComponent(aparatoId));
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
    } catch {
        return null;
    }
}

/** Una fila de `dispositivo_app` con los datos del aparato, aplanada para pintarla. `id` es el de la fila en la aplicación. */
export interface DispositivoDeBD {
    id: string;
    aparatoId: string;
    userId: string;
    clientId: string;
    sucursal: string | null;
    plataforma: string | null;
    version: string | null;
    equipo: string | null;
    nombre: string | null;
    /** Las OTRAS aplicaciones en las que está este mismo aparato (`clientId`). */
    tambienEn?: string[];
    vistoAt: Date;
    primeraVez: Date;
    ultimaDescarga: Date | null;
    ultimaSubida: Date | null;
    pendientes: number | null;
    rechazados: number | null;
    ultimoError: string | null;
    estadoAt: Date | null;
    bloqueadoAt: Date | null;
    /** Todas las cuentas que han entrado en este aparato. */
    personas?: { userId: string; primeraVez: Date; vistoAt: Date; version: string | null }[];
}

export interface CuentaDeFila {
    persona: string;
    primeraVez: string;
    vistoAt: string;
    version: string | null;
}

export interface FilaDeDispositivo {
    id: string;
    aparatoId: string;
    marca: Marca;
    /** La última cuenta que entró. */
    persona: string;
    /** TODAS las cuentas que han entrado en este aparato, la más reciente primero (un mismo PC lo usan varias personas). */
    cuentas: CuentaDeFila[];
    sucursal: string | null;
    plataforma: string | null;
    version: string | null;
    /** El nombre que se lee: el de un administrador, o el que informó el aparato. */
    nombre: string | null;
    /** El que puso un administrador (para editarlo sin pisar el del aparato). */
    nombrePuesto: string | null;
    vistoAt: string;
    ultimaDescarga: string | null;
    ultimaSubida: string | null;
    pendientes: number | null;
    rechazados: number | null;
    ultimoError: string | null;
    bloqueado: boolean;
    /** Nombres de las otras aplicaciones en las que está este MISMO aparato («CRM»): es uno solo, no una ficha por aplicación. */
    tambienEn: string[];
    actividadUrl: string | null;
}

export function aFila(
    d: DispositivoDeBD,
    personas: ReadonlyMap<string, string>,
    plantillaDeActividad: string | null,
    ahora: Date = new Date()
): FilaDeDispositivo {
    return {
        id: d.id,
        aparatoId: d.aparatoId,
        marca: marcaDelDispositivo(d, ahora),
        persona: personas.get(d.userId) ?? 'Persona dada de baja',
        cuentas: [...(d.personas ?? [])]
            .sort((a, b) => b.vistoAt.getTime() - a.vistoAt.getTime())
            .map((p) => ({
                persona: personas.get(p.userId) ?? 'Persona dada de baja',
                primeraVez: p.primeraVez.toISOString(),
                vistoAt: p.vistoAt.toISOString(),
                version: p.version,
            })),
        sucursal: d.sucursal,
        plataforma: d.plataforma,
        version: d.version,
        nombre: d.nombre ?? d.equipo,
        nombrePuesto: d.nombre,
        vistoAt: d.vistoAt.toISOString(),
        ultimaDescarga: d.ultimaDescarga?.toISOString() ?? null,
        ultimaSubida: d.ultimaSubida?.toISOString() ?? null,
        pendientes: d.pendientes,
        rechazados: d.rechazados,
        ultimoError: d.ultimoError,
        bloqueado: !!d.bloqueadoAt,
        tambienEn: [...new Set(d.tambienEn ?? [])].sort().map(nombreDeApp),
        actividadUrl: urlDeActividad(plantillaDeActividad, d.aparatoId),
    };
}

/** El resumen de arriba: cuántos hay de cada marca. */
export function contarMarcas(filas: readonly Pick<FilaDeDispositivo, 'marca'>[]): Record<Marca, number> {
    const c: Record<Marca, number> = { funciona: 0, atascado: 0, callado: 0, bloqueado: 0, sin_estado: 0 };
    for (const f of filas) c[f.marca]++;
    return c;
}


/** La pestaña «Todos»: el aparato UNA vez, con una etiqueta por cada aplicación en la que está. */
export interface EtiquetaDeApp {
    clientId: string;
    nombre: string;
    marca: Marca;
    version: string | null;
    sucursal: string | null;
    vistoAt: string;
}

export interface FilaDeAparato {
    id: string;
    aparatoId: string;
    nombre: string | null;
    plataforma: string | null;
    vistoAt: string;
    apps: EtiquetaDeApp[];
    /** Todas las cuentas que entraron en el aparato, en cualquier aplicación, la más reciente primero y sin repetir. */
    cuentas: { persona: string; app: string; vistoAt: string }[];
}

export interface AparatoDeBD {
    id: string;
    aparatoId: string;
    nombre: string | null;
    equipo: string | null;
    plataforma: string | null;
    vistoAt: Date;
    apps: (Omit<DispositivoDeBD, 'id' | 'aparatoId' | 'plataforma' | 'equipo' | 'nombre' | 'tambienEn' | 'personas'> & {
        personas?: { userId: string; vistoAt: Date }[];
    })[];
}

export function aFilaDeAparato(a: AparatoDeBD, personas: ReadonlyMap<string, string>, ahora: Date = new Date()): FilaDeAparato {
    const apps = [...a.apps].sort((x, y) => x.clientId.localeCompare(y.clientId));
    const vistas = new Map<string, { persona: string; app: string; vistoAt: Date }>();
    for (const app of apps) {
        for (const p of app.personas ?? []) {
            const persona = personas.get(p.userId) ?? 'Persona dada de baja';
            const prev = vistas.get(p.userId);
            if (!prev || prev.vistoAt < p.vistoAt) vistas.set(p.userId, { persona, app: nombreDeApp(app.clientId), vistoAt: p.vistoAt });
        }
    }
    return {
        id: a.id,
        aparatoId: a.aparatoId,
        nombre: a.nombre ?? a.equipo,
        plataforma: a.plataforma,
        vistoAt: a.vistoAt.toISOString(),
        apps: apps.map((d) => ({
            clientId: d.clientId,
            nombre: nombreDeApp(d.clientId),
            marca: marcaDelDispositivo(d, ahora),
            version: d.version,
            sucursal: d.sucursal,
            vistoAt: d.vistoAt.toISOString(),
        })),
        cuentas: [...vistas.values()].sort((x, y) => y.vistoAt.getTime() - x.vistoAt.getTime()).map((c) => ({ ...c, vistoAt: c.vistoAt.toISOString() })),
    };
}
