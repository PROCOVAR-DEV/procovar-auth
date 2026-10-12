import { SYSTEM_ROLE_NAMES } from './system-roles'
import { ungrantablePermissionKeys } from './grantable'
import type { ResolvedRbac } from './types'

/**
 * El escalafón: quién está por encima de quién.
 *
 * Escrito aquí, a propósito y en un solo sitio, porque es la decisión que evita que
 * un Administrador se ascienda solo. Hasta ahora el techo se deducía de los permisos
 * (`ungrantablePermissionKeys`: «no repartas una clave que tú no tienes»), y eso
 * contesta bien a «¿le estoy dando poder que yo no tengo?» pero contesta MAL a
 * «¿le estoy dando un rol por encima del mío?»:
 *
 *  - Por arriba fallaba: nada decía que ADMINISTRADOR no pueda repartir
 *    ADMINISTRADOR. Un administrador de Camagüey se clonaba en una segunda cuenta
 *    —mismo poder, otro nombre— y eso ya no es repartir, es duplicarse.
 *  - Por abajo fallaba al revés: GESTOR y SUPERVISOR llevan `vendedor.codigo`, que
 *    el ADMINISTRADOR NO tiene («mandan, no venden»). O sea que la regla de las
 *    claves le impedía dar de alta justo a los vendedores, que es lo que pide.
 *
 * Así que el techo se dice por su nombre. El orden es el de `SYSTEM_ROLE_NAMES`
 * —el mismo que ya usa `PRECEDENCE` para decidir qué rol manda cuando alguien
 * lleva varios—, de más poder a menos:
 *
 *   DESARROLLADOR > SUPER ADMIN > ADMINISTRADOR > GERENTE > SUPERVISOR > GESTOR > OPERADOR
 *
 * OJO con el orden de `procovar/CLAUDE.md`, que lista GERENTE antes que
 * ADMINISTRADOR: eso es el orden en que se escribieron, no un escalafón. Los
 * permisos sembrados dicen lo contrario y son los que mandan — GERENTE es
 * exactamente ADMINISTRADOR menos repartir accesos, auditoría e integraciones
 * (`GERENTE_EXCLUIDOS ⊇ ADMIN_EXCLUIDOS_BASE`), así que GERENTE está por DEBAJO.
 */
export const ESCALAFON: readonly string[] = SYSTEM_ROLE_NAMES

/** Dónde cae este rol. `null` = no es del escalafón (un rol hecho a mano). */
export function rangoDeRol(nombre: string): number | null {
  const i = ESCALAFON.indexOf((nombre || '').toUpperCase().trim())
  return i === -1 ? null : i
}

/**
 * El rango de quien pide: el MÁS ALTO de los que lleva.
 *
 * Alguien puede llevar varios roles y lo que puede hacer es la suma de todos
 * (`resolveRbac`), así que su techo tiene que salir del más alto. Sacarlo del
 * primero de la lista dejaría el techo a merced del orden en que vinieran de la
 * base de datos.
 *
 * `null` = no lleva ningún rol del escalafón, y entonces no reparte ninguno.
 */
export function rangoDelActor(nombres: readonly string[]): number | null {
  let mejor: number | null = null
  for (const n of nombres) {
    const r = rangoDeRol(n)
    if (r !== null && (mejor === null || r < mejor)) mejor = r
  }
  return mejor
}

/**
 * Claves que son una ETIQUETA, no un poder.
 *
 * `vendedor.codigo` no deja hacer nada: dice que esa persona lleva código de
 * vendedor, y lo único que cambia es que el formulario le pide el código. Quien
 * manda no vende, así que el ADMINISTRADOR no la tiene — y si contara como poder,
 * no podría dar de alta a un GESTOR, que es precisamente para lo que existe esta
 * pantalla.
 *
 * Sólo se perdona dentro del escalafón: en un rol hecho a mano no sabemos qué
 * significa, así que ahí se exige como cualquier otra.
 */
export const MARCADORES_SIN_PODER: ReadonlySet<string> = new Set(['vendedor.codigo'])

export interface RolPedido {
  name: string
  /** Las claves de permiso que lleva el rol. */
  claves: readonly string[]
}

/**
 * ¿Puede esta persona repartir ESTE rol?
 *
 * Dos vallas, y hay que pasar las dos:
 *
 *  1. **El escalafón**: sólo por DEBAJO del suyo. Ni el mismo que el suyo —clonarse
 *     no es repartir— ni ninguno por encima. Un ADMINISTRADOR reparte GERENTE,
 *     SUPERVISOR, GESTOR y OPERADOR, y nada más.
 *  2. **Las claves**: lo de siempre, que no reparta poder que él no tiene. Sigue
 *     haciendo falta porque los roles se editan desde la pantalla de Permisos: si
 *     alguien le cuelga `app.manage` a GESTOR, el escalafón solo no lo vería.
 *
 * Un rol que no es del escalafón (hecho a mano) no tiene rango, así que sólo pasa
 * por la segunda — que es exactamente lo que ya se comprobaba antes de esto.
 *
 * Sin `rbac` no se reparte nada: negar por defecto.
 */
export function puedeRepartirRol(
  rbac: ResolvedRbac | null | undefined,
  rolesDelActor: readonly string[],
  rol: RolPedido,
): boolean {
  if (!rbac) return false
  // El Super Admin y el Desarrollador reparten lo que sea: están por encima de todo.
  if (rbac.wildcard) return true

  let claves: readonly string[] = rol.claves
  const pedido = rangoDeRol(rol.name)
  if (pedido !== null) {
    const mio = rangoDelActor(rolesDelActor)
    // Sin rol del escalafón no hay techo que calcular, así que no reparte ninguno.
    if (mio === null) return false
    // `<=` y no `<`: el mismo rango tampoco. Ver el comentario de arriba.
    if (pedido <= mio) return false
    claves = claves.filter((k) => !MARCADORES_SIN_PODER.has(k))
  }

  return ungrantablePermissionKeys(rbac, [...claves]).length === 0
}

/** Los del catálogo que sí puede repartir. Lo que la pantalla debe ofrecerle. */
export function rolesRepartibles<T extends RolPedido>(
  rbac: ResolvedRbac | null | undefined,
  rolesDelActor: readonly string[],
  catalogo: readonly T[],
): T[] {
  return catalogo.filter((r) => puedeRepartirRol(rbac, rolesDelActor, r))
}
