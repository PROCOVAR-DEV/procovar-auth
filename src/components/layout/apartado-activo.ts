/**
 * Qué apartado del menú lateral está encendido.
 *
 * Solo UNO: el de `href` más largo que case con la ruta. Con «coincide o es subruta» a
 * secas, en `/profile/org` se encendían a la vez «Mi cuenta» (`/profile`) y «Mi sucursal»
 * (`/profile/org`). Coincidir es ser la ruta exacta o una subruta con barra: un
 * `startsWith` pelado marcaría `/profile` también en `/profile-otra`. La raíz `/` solo
 * casa consigo misma, porque toda ruta empieza por `/`.
 */
export function apartadoActivo(ruta: string, hrefs: readonly string[]): string | null {
    let mejor: string | null = null;
    for (const href of hrefs) {
        const casa = href === "/" ? ruta === "/" : ruta === href || ruta.startsWith(`${href}/`);
        if (casa && (mejor === null || href.length > mejor.length)) mejor = href;
    }
    return mejor;
}
