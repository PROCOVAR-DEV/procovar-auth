/**
 * Los roles que se FIRMAN de una persona: los de la base, sin repetir, más `SUPER ADMIN`
 * si Accesos la tiene marcada como administradora del sistema (`isSystemAdmin`).
 *
 * Existe porque una cuenta `isSystemAdmin` puede no tener rol por defecto NI membresía
 * —un Super Admin no pertenece a ninguna sucursal, precisamente por eso las ve todas—,
 * y entonces `role` salía vacío y `roles` vacío. Reparto decide quién entra por el
 * NOMBRE del rol que viene en el token, y la web del reparto ya le añadía `SUPER ADMIN`
 * a esa cuenta (`RolesDeVerdad`): por la APK y el escritorio se quedaba fuera. Mismos
 * criterios que allí: se compara sin mayúsculas ni espacios y no se duplica.
 *
 * Lo usan la APK (`resolverIdentidad`) y la web (`/api/auth/exchange`): los dos sitios que
 * firman la identidad para Reparto y tienen que decir lo mismo. NO lo usan las dos
 * `verify-session` (PEDIDO y las demás aplicaciones leen allí `rbac.wildcard` e
 * `isSystemAdmin` por su cuenta): a una cuenta `isSystemAdmin` sin rol esas le siguen
 * dando `role: null`, a propósito, para no cambiarle el contrato a nadie más.
 */
export const SUPER_ADMIN = 'SUPER ADMIN';

const esSuperAdmin = (r: string) => r.trim().toUpperCase() === SUPER_ADMIN;

export function rolesFirmados(roles: readonly string[], isSystemAdmin: boolean): string[] {
    const unicos = [...new Set(roles)];
    return isSystemAdmin && !unicos.some(esSuperAdmin) ? [...unicos, SUPER_ADMIN] : unicos;
}

/**
 * El rol principal: el rol por defecto de la persona; y si no tiene y es administradora
 * del sistema, `SUPER ADMIN`. Si no, `null`: NO se escoge «el primero de una membresía»,
 * porque el orden de `memberRoles` lo decide la base y el techo de una persona no puede
 * quedar a merced de eso (la APK conserva su propia caída al primero, que ya tenía).
 */
export function rolPrincipal(porDefecto: string | null | undefined, isSystemAdmin: boolean): string | null {
    return porDefecto ?? (isSystemAdmin ? SUPER_ADMIN : null);
}
