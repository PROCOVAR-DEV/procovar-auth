/**
 * Qué parte de better-auth queda expuesta en `/api/auth/[...all]`.
 *
 * El plugin `organization` trae ~40 endpoints (`remove-member`, `update-member-role`, `leave`,
 * `accept-invitation`, `delete`…) que cambian membresías SIN pasar por nuestros avisos a las demás
 * aplicaciones (`lib/eventos-de-sesion.ts`). La interfaz sólo usa `set-active`
 * (`authClient.organization.setActive`); las altas, bajas y roles de una sucursal van por las
 * acciones de servidor del panel y por `/api/organizations/**`, que sí publican.
 *
 * Regla: dentro de `organization/**` sólo se deja pasar `set-active` y las LECTURAS (GET). Lo que
 * añada una versión futura de la librería queda cerrado por defecto.
 */
const ES_ORGANIZACION = /\/organization(\/|$)/;
const ES_SET_ACTIVE = /\/organization\/set-active\/*$/;

export function rutaBloqueada(metodo: string, pathname: string): boolean {
    let ruta = pathname;
    try { ruta = decodeURIComponent(pathname); } catch { /* ruta rara: se mira tal cual */ }
    ruta = ruta.toLowerCase().replace(/\/{2,}/g, '/');
    if (!ES_ORGANIZACION.test(ruta)) return false;
    if (ES_SET_ACTIVE.test(ruta)) return false;
    return metodo.toUpperCase() !== 'GET';
}
