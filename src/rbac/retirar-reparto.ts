import { REPARTO_KEYS, systemRolePermissionKeys } from './system-roles'

/**
 * Quitar Reparto de los roles que ya no entran, EN LA BASE.
 *
 * Cambiar `system-roles.ts` no basta: el sync (`sync.ts`) solo SIEMBRA y nunca quita,
 * así que los cuatro roles que ya existen seguirían con sus filas de `role_permission`
 * hasta el fin de los tiempos. Esto es lo que las borra.
 *
 * La lógica vive aquí, con la base inyectada, para poder probarla sin Postgres; el
 * ejecutable es `scripts/retirar-reparto-de-roles.ts`.
 */

/** Los únicos cuatro roles a los que se les toca. Escritos a mano, a propósito. */
export const ROLES_SIN_REPARTO = ['GESTOR', 'OPERADOR', 'SUPERVISOR', 'GERENTE'] as const

/** Lo mínimo de la base que usa esto. Prisma lo cumple; las pruebas, con una en memoria. */
export interface DbRetirar {
  role: {
    findMany(args: unknown): Promise<
      Array<{
        id: string
        name: string
        permissions: Array<{ permission: { key: string } | null }>
        _count: { memberRoles: number; usuarios: number }
      }>
    >
  }
  rolePermission: { deleteMany(args: unknown): Promise<{ count: number }> }
  $transaction<T>(fn: (tx: DbRetirar) => Promise<T>): Promise<T>
}

export interface RolLeido {
  id: string
  name: string
  /** Las llaves de Reparto que lleva ahora mismo, ordenadas. */
  reparto: string[]
  /** Membresías (rol por sucursal) y personas con este rol por defecto. */
  membresias: number
  porDefecto: number
}

export interface Lectura {
  roles: RolLeido[]
  logistico: { existe: boolean; faltan: string[] }
}

const NOMBRES = [...ROLES_SIN_REPARTO, 'LOGISTICO']

export async function leer(db: DbRetirar): Promise<Lectura> {
  const filas = await db.role.findMany({
    where: { name: { in: NOMBRES } },
    select: {
      id: true,
      name: true,
      permissions: { select: { permission: { select: { key: true } } } },
      _count: { select: { memberRoles: true, usuarios: true } },
    },
  })
  const repartoSet = new Set(REPARTO_KEYS)
  const clavesDe = (f: (typeof filas)[number]) =>
    f.permissions.map((p) => p.permission?.key).filter((k): k is string => Boolean(k))

  const roles = ROLES_SIN_REPARTO.flatMap((name) => {
    const f = filas.find((x) => x.name === name)
    if (!f) return []
    return [{
      id: f.id,
      name,
      reparto: clavesDe(f).filter((k) => repartoSet.has(k)).sort(),
      membresias: f._count.memberRoles,
      porDefecto: f._count.usuarios,
    }]
  })

  const log = filas.find((x) => x.name === 'LOGISTICO')
  const tiene = new Set(log ? clavesDe(log) : [])
  return {
    roles,
    logistico: {
      existe: Boolean(log),
      faltan: log ? systemRolePermissionKeys('LOGISTICO').filter((k) => !tiene.has(k)) : [],
    },
  }
}

/**
 * Borra las llaves de Reparto de los cuatro roles, dentro de UNA transacción.
 *
 * Se vuelve a leer ADENTRO y, si queda alguna, se lanza: la transacción se deshace
 * entera. Mejor un error que dejar tres roles a medias.
 */
/**
 * ¿SE PUEDE ESCRIBIR YA? `null` si sí; si no, el motivo.
 *
 * El candado que demuestra que el código NUEVO de Accesos ya arrancó: LOGISTICO existe Y
 * tiene sus llaves completas (las siembra `syncRbac` al arrancar). Con sólo «existe» no
 * bastaba: si LOGISTICO ya estaba creado de antes, `--aplicar` pasaba con el código viejo
 * corriendo, y un reinicio de éste vuelve a sembrar Reparto en los cuatro roles (su paso
 * 2b sólo suma). Auditoría de seguridad del 08/10/2026 (H3).
 */
export function motivoParaNoAplicar(l: Lectura): string | null {
  if (!l.logistico.existe) {
    return 'LOGISTICO no existe. Despliega Accesos primero (syncRbac lo crea al arrancar).'
  }
  if (l.logistico.faltan.length) {
    return `LOGISTICO está incompleto (le faltan ${l.logistico.faltan.join(', ')}): ¿está ya desplegado el Accesos nuevo?`
  }
  return null
}

export async function aplicar(db: DbRetirar): Promise<{ antes: Lectura; despues: Lectura; filas: number }> {
  return db.$transaction(async (tx) => {
    const antes = await leer(tx)
    let filas = 0
    for (const r of antes.roles) {
      const { count } = await tx.rolePermission.deleteMany({
        where: { roleId: r.id, permission: { key: { in: [...REPARTO_KEYS] } } },
      })
      filas += count
    }
    const despues = await leer(tx)
    const sobran = despues.roles.filter((r) => r.reparto.length > 0)
    if (sobran.length) {
      throw new Error(`Quedan llaves de Reparto en ${sobran.map((r) => r.name).join(', ')}: se deshace todo.`)
    }
    return { antes, despues, filas }
  })
}
