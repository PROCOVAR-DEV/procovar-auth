/**
 * `retirar-reparto.ts`: quitar Reparto de los cuatro roles que ya no entran.
 *
 * No hay Postgres de pruebas en este repo, así que la base es una TABLA EN MEMORIA que
 * evalúa de verdad el `where` del `deleteMany`. Un mock que siempre contesta
 * `{ count: 1 }` diría que sí tanto con el filtro bueno como sin él, y lo único que hay
 * que demostrar aquí es que NO se llevan por delante lo que no toca.
 */
import { describe, it, expect } from 'vitest'
import { ROLES_SIN_REPARTO, aplicar, leer, motivoParaNoAplicar, type DbRetirar } from '../retirar-reparto'
import { PERMISSION_CATALOG } from '../permissions.catalog'
import { REPARTO_KEYS, SYSTEM_ROLE_NAMES } from '../system-roles'

/** Como estaba producción ANTES: los cuatro con Reparto, tal y como los sembraba el código viejo. */
const VIEJO: Record<string, string[]> = {
  GESTOR: ['pedido.entrar', 'delivery.entrar', 'pedido.read', 'reparto.read', 'vendedor.codigo'],
  OPERADOR: ['pedido.entrar', 'delivery.entrar', 'pedido.read', 'reparto.read', 'pedido.complete'],
  SUPERVISOR: [
    'pedido.entrar', 'delivery.entrar', 'reparto.read', 'reparto.assign', 'reparto.complete', 'reparto.report',
    'ruta.read', 'ruta.manage', 'vehiculo.read', 'almacen.read', 'analitics.entrar', 'rutas.entrar',
  ],
  GERENTE: [
    'pedido.entrar', 'aft.entrar', ...PERMISSION_CATALOG.filter((p) => p.service === 'delivery').map((p) => p.key),
  ],
  // Los que NO se tocan: llevan todo Reparto.
  ADMINISTRADOR: ['member.invite', ...REPARTO_KEYS],
  'SUPER ADMIN': ['app.manage', ...REPARTO_KEYS],
  DESARROLLADOR: ['avisos.entrar', ...REPARTO_KEYS],
}

function baseEnMemoria(opciones: { logistico?: string[] | null; fallarAlBorrar?: boolean } = {}) {
  const roles = new Map<string, string>() // nombre -> id
  let filas: Array<{ roleId: string; key: string }> = []
  const alta = (nombre: string, claves: string[]) => {
    roles.set(nombre, `id-${nombre}`)
    claves.forEach((key) => filas.push({ roleId: `id-${nombre}`, key }))
  }
  for (const [n, k] of Object.entries(VIEJO)) alta(n, k)
  if (opciones.logistico !== null) alta('LOGISTICO', opciones.logistico ?? [])

  const montar = (): DbRetirar => ({
    role: {
      async findMany(args: unknown) {
        const nombres = (args as { where: { name: { in: string[] } } }).where.name.in
        return [...roles].filter(([n]) => nombres.includes(n)).map(([name, id]) => ({
          id,
          name,
          permissions: filas.filter((f) => f.roleId === id).map((f) => ({ permission: { key: f.key } })),
          _count: { memberRoles: 3, usuarios: 1 },
        }))
      },
    },
    rolePermission: {
      async deleteMany(args: unknown) {
        const w = (args as { where: { roleId: string; permission: { key: { in: string[] } } } }).where
        const antes = filas.length
        filas = filas.filter((f) => !(f.roleId === w.roleId && w.permission.key.in.includes(f.key)))
        if (opciones.fallarAlBorrar) throw new Error('se cayó la base')
        return { count: antes - filas.length }
      },
    },
    // Transacción de verdad: si el cuerpo lanza, se vuelve a como estaba.
    async $transaction<T>(fn: (tx: DbRetirar) => Promise<T>) {
      const copia = [...filas]
      try {
        return await fn(montar())
      } catch (e) {
        filas = copia
        throw e
      }
    },
  })
  return { db: montar(), claves: (n: string) => filas.filter((f) => f.roleId === `id-${n}`).map((f) => f.key) }
}

describe('retirar Reparto de los roles en la base', () => {
  it('la lista cerrada son GESTOR, OPERADOR, SUPERVISOR y GERENTE, y nada más', () => {
    expect([...ROLES_SIN_REPARTO]).toEqual(['GESTOR', 'OPERADOR', 'SUPERVISOR', 'GERENTE'])
    for (const n of ['ADMINISTRADOR', 'SUPER ADMIN', 'DESARROLLADOR', 'LOGISTICO']) {
      expect((ROLES_SIN_REPARTO as readonly string[]).includes(n)).toBe(false)
      expect(SYSTEM_ROLE_NAMES).toContain(n)
    }
  })

  it('leer no escribe, y cuenta las llaves de Reparto de cada uno', async () => {
    const { db, claves } = baseEnMemoria()
    const antes = claves('GERENTE').length
    const l = await leer(db)
    expect(l.roles.map((r) => [r.name, r.reparto.length])).toEqual([
      ['GESTOR', 2], ['OPERADOR', 2], ['SUPERVISOR', 9], ['GERENTE', 12],
    ])
    expect(claves('GERENTE')).toHaveLength(antes)
  })

  it('al aplicar, los cuatro quedan sin ninguna llave de Reparto', async () => {
    const { db, claves } = baseEnMemoria()
    const r = await aplicar(db)
    for (const n of ROLES_SIN_REPARTO) {
      expect(claves(n).filter((k) => REPARTO_KEYS.includes(k)), n).toEqual([])
    }
    expect(r.filas).toBe(2 + 2 + 9 + 12)
    expect(r.despues.roles.every((x) => x.reparto.length === 0)).toBe(true)
  })

  it('NO se lleva lo que no es de Reparto: ni pedidos, ni Analitics, ni Rutas, ni el código de vendedor', async () => {
    const { db, claves } = baseEnMemoria()
    await aplicar(db)
    expect(claves('GESTOR').sort()).toEqual(['pedido.entrar', 'pedido.read', 'vendedor.codigo'])
    expect(claves('OPERADOR').sort()).toEqual(['pedido.complete', 'pedido.entrar', 'pedido.read'])
    expect(claves('SUPERVISOR').sort()).toEqual(['analitics.entrar', 'pedido.entrar', 'rutas.entrar'])
    expect(claves('GERENTE').sort()).toEqual(['aft.entrar', 'pedido.entrar'])
  })

  it('ADMINISTRADOR, SUPER ADMIN, DESARROLLADOR y LOGISTICO quedan EXACTAMENTE como estaban', async () => {
    const logistico = ['delivery.entrar', 'reparto.read']
    const { db, claves } = baseEnMemoria({ logistico })
    const antes = Object.fromEntries(
      ['ADMINISTRADOR', 'SUPER ADMIN', 'DESARROLLADOR', 'LOGISTICO'].map((n) => [n, [...claves(n)]]),
    )
    await aplicar(db)
    for (const [n, k] of Object.entries(antes)) expect(claves(n), n).toEqual(k)
    expect(claves('ADMINISTRADOR')).toHaveLength(1 + REPARTO_KEYS.length)
  })

  it('es idempotente: la segunda vez no encuentra nada', async () => {
    const { db } = baseEnMemoria()
    await aplicar(db)
    const otra = await aplicar(db)
    expect(otra.filas).toBe(0)
  })

  it('si la base falla a mitad, no queda ningún rol a medias', async () => {
    const { db, claves } = baseEnMemoria({ fallarAlBorrar: true })
    const antes = ROLES_SIN_REPARTO.map((n) => [...claves(n)])
    await expect(aplicar(db)).rejects.toThrow('se cayó la base')
    expect(ROLES_SIN_REPARTO.map((n) => claves(n))).toEqual(antes)
  })

  it('dice si LOGISTICO existe y qué le falta', async () => {
    expect((await leer(baseEnMemoria({ logistico: null }).db)).logistico).toEqual({ existe: false, faltan: [] })

    const completo = await leer(baseEnMemoria({
      logistico: ['delivery.entrar', 'reparto.read', 'reparto.assign', 'reparto.complete', 'reparto.report',
        'ruta.read', 'ruta.manage', 'vehiculo.read', 'almacen.read'],
    }).db)
    expect(completo.logistico).toEqual({ existe: true, faltan: [] })

    const cojo = await leer(baseEnMemoria({ logistico: ['delivery.entrar'] }).db)
    expect(cojo.logistico.existe).toBe(true)
    expect(cojo.logistico.faltan).toContain('reparto.assign')
  })

  // EL CANDADO DEL SCRIPT (auditoría de seguridad, H3): con sólo «LOGISTICO existe» se podía
  // aplicar con el código viejo de Accesos corriendo, y un reinicio de éste vuelve a sembrar
  // Reparto en los cuatro roles. Hace falta que esté EXISTENTE Y COMPLETO.
  describe('motivoParaNoAplicar: cuándo el script se niega', () => {
    const COMPLETO = ['delivery.entrar', 'reparto.read', 'reparto.assign', 'reparto.complete', 'reparto.report',
      'ruta.read', 'ruta.manage', 'vehiculo.read', 'almacen.read']

    it('se niega si LOGISTICO no existe', async () => {
      expect(motivoParaNoAplicar(await leer(baseEnMemoria({ logistico: null }).db))).toMatch(/no existe/)
    })

    it('se niega si LOGISTICO existe pero está incompleto (el código nuevo aún no sembró sus llaves)', async () => {
      const motivo = motivoParaNoAplicar(await leer(baseEnMemoria({ logistico: ['delivery.entrar'] }).db))
      expect(motivo).toMatch(/incompleto/)
      expect(motivo).toContain('reparto.assign')
    })

    it('deja pasar sólo con LOGISTICO completo', async () => {
      expect(motivoParaNoAplicar(await leer(baseEnMemoria({ logistico: COMPLETO }).db))).toBeNull()
    })
  })

  it('si tras borrar quedara alguna llave de Reparto, se deshace todo (la guarda «sobran»)', async () => {
    const { db } = baseEnMemoria({ logistico: [] })
    // Una base que dice haber borrado pero no borra nada: el segundo `leer` sigue viendo Reparto.
    const quedaTodo: DbRetirar = {
      ...db,
      $transaction: (fn: (tx: DbRetirar) => Promise<unknown>) =>
        db.$transaction((tx: DbRetirar) =>
          fn({ ...tx, rolePermission: { ...tx.rolePermission, deleteMany: async () => ({ count: 0 }) } } as DbRetirar)),
    } as DbRetirar
    await expect(aplicar(quedaTodo)).rejects.toThrow(/se deshace todo/)
  })
})
