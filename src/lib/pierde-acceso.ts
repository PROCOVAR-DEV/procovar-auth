/**
 * ¿Alguien se queda SIN algo que tenía? Sólo entonces se avisa a las aplicaciones.
 *
 * Regla de `docs/sesion-unica.md`: `permisos-cambiados` (alcance `todo`) se publica cuando una persona
 * PIERDE acceso. Dar acceso —alta de membresía, un rol o una llave que se añaden— no publica nada,
 * porque sólo se gana. Si no, cualquiera con permiso para dar de alta podría echar de todas las
 * aplicaciones a quien quiera "dándole de alta" (auditoría 08/10/2026).
 */

/** Hay alguna llave en `antes` que ya no está en `despues`. */
export function pierdeLlaves(antes: Iterable<string>, despues: Iterable<string>): boolean {
    const quedan = new Set(despues);
    for (const k of antes) if (!quedan.has(k)) return true;
    return false;
}

/**
 * Editar una sucursal: `activa` y `codigo` deciden las sucursales del acceso de cada persona
 * (`resolverIdentidad`). Pierde acceso cuando se DESACTIVA o cuando cambia el código (los demás
 * sistemas la conocían por el viejo). Reactivarla sólo da acceso.
 */
export function sucursalPierdeAcceso(
    antes: { activa: boolean; codigo: string | null },
    despues: { activa: boolean; codigo: string | null },
): boolean {
    return (antes.activa && !despues.activa) || antes.codigo !== despues.codigo;
}

const RANGO: Record<string, number> = { agent: 0, staff: 1, admin: 2, owner: 3 };

/**
 * Cambio del rol de la membresía de better-auth (`owner`/`admin`/`staff`/`agent`): sólo el ASCENSO
 * es seguro. Igual no cambia nada; bajar, o salir de un rol que no está en la escala, se avisa.
 */
export function cambioDeRolPuedeQuitar(antes: string, despues: string): boolean {
    if (antes === despues) return false;
    return !(antes in RANGO && despues in RANGO && RANGO[despues] > RANGO[antes]);
}
