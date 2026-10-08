import { describe, it, expect } from 'vitest'
import { SYSTEM_ROLE_NAMES, ROL_MINIMO, PRECEDENCE, REPARTO_KEYS, systemRolePermissionKeys, ROLE_DESCRIPTIONS } from '../system-roles'
import { PERMISSION_CATALOG } from '../permissions.catalog'

describe('los roles de Procovar', () => {
  it('son los diez, escritos como los escribe PEDIDO', () => {
    // Si alguien los renombra aquí, PEDIDO deja de reconocer el rol que recibe
    // y todo el mundo pasa a ser "desconocido". Por eso están clavados.
    //
    // GERENTE entró después, entre el Administrador y el Supervisor: está por
    // encima del supervisor y ve toda su sucursal, pero no administra.
    //
    // DESARROLLADOR entró el último y por ENCIMA del Super Admin: es el único que
    // lleva las claves de Avisos (ver SOLO_DESARROLLADOR en system-roles.ts).
    //
    // ECONOMICA y ANALISTA entraron el 30/09/2026 y van AL FINAL a propósito: este
    // array es también `PRECEDENCE`, así que ponerlos en medio le habría bajado el
    // rol a quien lleve dos. Ver la nota larga en system-roles.ts.
    //
    // LOGISTICO entró el 08/10/2026 y va detrás de ANALISTA por lo mismo: es de oficio,
    // y añadírselo a alguien no puede bajarle el rol con el que ya trabaja.
    expect([...SYSTEM_ROLE_NAMES]).toEqual([
      'DESARROLLADOR', 'SUPER ADMIN', 'ADMINISTRADOR', 'GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR',
      'ECONOMICA', 'ANALISTA', 'LOGISTICO',
    ])
  })

  it('los roles de oficio van por DEBAJO de los siete de mando, sin excepción', () => {
    // Es la razón entera de que vayan al final, y hay que decirla como propiedad y
    // no con dos ejemplos: la primera versión de esta prueba comparaba ECONOMICA
    // con ADMINISTRADOR y GESTOR con ANALISTA, y metiendo ECONOMICA en medio del
    // escalafón seguía pasando. Verde sin probar nada.
    //
    // Lo que de verdad hay que sostener: añadirle uno de estos dos a cualquiera
    // NUNCA le cambia el `member.role` con el que ya trabajaba.
    const MANDO = ['DESARROLLADOR', 'SUPER ADMIN', 'ADMINISTRADOR', 'GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR']
    const OFICIO = ['ECONOMICA', 'ANALISTA', 'LOGISTICO']
    const gana = (...roles: string[]) => [...PRECEDENCE].find((r) => roles.includes(r))

    for (const oficio of OFICIO) {
      for (const mando of MANDO) {
        expect(gana(oficio, mando), `${oficio} no puede ganarle a ${mando}`).toBe(mando)
      }
    }
    // Y a solas, cada uno es él mismo.
    expect(gana('ECONOMICA')).toBe('ECONOMICA')
    expect(gana('ANALISTA')).toBe('ANALISTA')
    expect(gana('LOGISTICO')).toBe('LOGISTICO')
  })

  it('la económica lleva AFT entero y nada de pedidos', () => {
    const suyas = systemRolePermissionKeys('ECONOMICA')
    const aft = PERMISSION_CATALOG.filter((p) => p.service === 'aft').map((p) => p.key)

    expect([...suyas].sort()).toEqual([...aft].sort())
    // El catálogo incluido: quien inventaría necesita crear el área donde va el activo.
    expect(suyas).toContain('aft.manage')
    expect(suyas.some((k) => k.startsWith('pedido.'))).toBe(false)
    expect(suyas.some((k) => k.startsWith('cliente.'))).toBe(false)
  })

  it('ANALISTA nace vacío: se puede repartir sin abrirle nada a nadie', () => {
    // Jose lo pidió el 30/09/2026 y dijo «después te doy los permisos». Inventarle
    // claves mientras tanto es dar acceso que no autorizó nadie.
    expect(systemRolePermissionKeys('ANALISTA')).toEqual([])
  })

  // ── Reparto: sólo ADMINISTRADOR, SUPER ADMIN, DESARROLLADOR y LOGISTICO ──────────
  //
  // Jose, 08/10/2026: «los logísticos, admins, superadmins y desarrolladores son los
  // únicos que pueden entrar a Reparto; a los otros quítales esos permisos».

  /** Las doce del servicio `delivery`, escritas a mano: si alguien añade o quita una
   *  del catálogo, esta prueba obliga a decidir quién la lleva. */
  const REPARTO_A_MANO = [
    'delivery.entrar', 'reparto.read', 'reparto.assign', 'reparto.complete', 'reparto.report',
    'reparto.sync', 'ruta.read', 'ruta.manage', 'vehiculo.read', 'vehiculo.manage',
    'almacen.read', 'almacen.manage',
  ]

  it('REPARTO_KEYS es el servicio delivery entero, y son las doce de siempre', () => {
    expect([...REPARTO_KEYS].sort()).toEqual([...REPARTO_A_MANO].sort())
  })

  it('el logístico lleva EXACTAMENTE las nueve de Reparto, y nada más', () => {
    expect([...systemRolePermissionKeys('LOGISTICO')].sort()).toEqual([
      'almacen.read', 'delivery.entrar', 'reparto.assign', 'reparto.complete', 'reparto.read',
      'reparto.report', 'ruta.manage', 'ruta.read', 'vehiculo.read',
    ])
  })

  it('el logístico no lleva ni la sincronización ni la gestión de flota y almacén', () => {
    // Las tres que ni el Supervisor tuvo. Es una decisión (ver system-roles.ts), y si
    // se revierte tiene que ser a propósito.
    const suyas = systemRolePermissionKeys('LOGISTICO')
    for (const k of ['reparto.sync', 'vehiculo.manage', 'almacen.manage']) {
      expect(suyas, k).not.toContain(k)
    }
  })

  it('el logístico no toca pedidos, clientes, vendedores ni accesos', () => {
    const suyas = systemRolePermissionKeys('LOGISTICO')
    expect(suyas.every((k) => REPARTO_A_MANO.includes(k))).toBe(true)
    for (const k of ['pedido.entrar', 'pedido.read', 'cliente.read', 'vendedor.codigo', 'member.read']) {
      expect(suyas, k).not.toContain(k)
    }
  })

  it.each(['GESTOR', 'OPERADOR', 'SUPERVISOR', 'GERENTE', 'ECONOMICA', 'ANALISTA'])(
    '%s no lleva NI UNA llave de Reparto',
    (nombre) => {
      const suyas = new Set(systemRolePermissionKeys(nombre))
      for (const k of REPARTO_A_MANO) expect(suyas.has(k), `${nombre} no debería tener ${k}`).toBe(false)
    },
  )

  it.each(['ADMINISTRADOR', 'SUPER ADMIN', 'DESARROLLADOR'])('%s sigue llevando las doce de Reparto', (nombre) => {
    const suyas = new Set(systemRolePermissionKeys(nombre))
    for (const k of REPARTO_A_MANO) expect(suyas.has(k), `${nombre} debería tener ${k}`).toBe(true)
  })

  it('a Reparto entran exactamente esos cuatro roles y ningún otro', () => {
    const entran = SYSTEM_ROLE_NAMES.filter((n) => systemRolePermissionKeys(n).includes('delivery.entrar'))
    expect([...entran].sort()).toEqual(['ADMINISTRADOR', 'DESARROLLADOR', 'LOGISTICO', 'SUPER ADMIN'])
  })

  it('quitarle Reparto al Supervisor no le quita nada más', () => {
    // Todo lo que tenía antes de este cambio menos Reparto, para que una poda pase de
    // largo sin llevarse Analitics, Rutas o Parranda.
    const sup = systemRolePermissionKeys('SUPERVISOR')
    for (const k of [
      'pedido.entrar', 'pedido.read', 'pedido.complete', 'analitics.entrar', 'analitics.read',
      'ccsa.entrar', 'rutas.entrar', 'rutas.calendario', 'reporte.read', 'vendedor.manage', 'vendedor.codigo',
    ]) {
      expect(sup, k).toContain(k)
    }
  })

  it('todos tienen descripción: en la pantalla hay que saber qué es cada uno', () => {
    for (const nombre of SYSTEM_ROLE_NAMES) {
      expect(ROLE_DESCRIPTIONS[nombre]).toBeTruthy()
    }
  })

  it('el Desarrollador llega a todo el catálogo, sin excepciones', () => {
    const todos = PERMISSION_CATALOG.map((p) => p.key).sort()
    expect(systemRolePermissionKeys('DESARROLLADOR').sort()).toEqual(todos)
  })

  it('el Super Admin llega a todo MENOS Avisos', () => {
    // La única excepción a "el Super Admin lo ve todo", y es deliberada:
    // configurar plantillas y canales de aviso es trastienda técnica.
    const avisos = PERMISSION_CATALOG.filter((p) => p.service === 'avisos').map((p) => p.key)
    const esperado = PERMISSION_CATALOG.map((p) => p.key).filter((k) => !avisos.includes(k)).sort()
    expect(avisos.length).toBeGreaterThan(0)
    expect(systemRolePermissionKeys('SUPER ADMIN').sort()).toEqual(esperado)
  })

  it('nadie más que el Desarrollador toca Avisos', () => {
    const avisos = PERMISSION_CATALOG.filter((p) => p.service === 'avisos').map((p) => p.key)
    for (const nombre of SYSTEM_ROLE_NAMES) {
      if (nombre === 'DESARROLLADOR') continue
      const suyas = new Set(systemRolePermissionKeys(nombre))
      for (const k of avisos) {
        expect(suyas.has(k), `${nombre} no debería tener ${k}`).toBe(false)
      }
    }
  })

  it('el Administrador manda en su sucursal, pero no en toda Procovar', () => {
    const admin = systemRolePermissionKeys('ADMINISTRADOR')
    expect(admin).toContain('member.invite')
    expect(admin).toContain('member.assignRole')
    expect(admin).toContain('reporte.read')
    // Registrar aplicaciones y borrar roles del catálogo afectan a las ocho
    // sucursales a la vez: eso es del Super Admin.
    expect(admin).not.toContain('app.manage')
    expect(admin).not.toContain('role.delete')
  })

  it('el Supervisor trabaja la sucursal pero no reparte accesos', () => {
    const sup = systemRolePermissionKeys('SUPERVISOR')
    expect(sup).toContain('vendedor.manage')
    expect(sup).toContain('pedido.import')
    expect(sup).toContain('reporte.read')
    expect(sup).toContain('member.read')
    expect(sup).not.toContain('member.assignRole')
    expect(sup).not.toContain('member.invite')
  })

  it('el Operador factura y nada más: ni CSV, ni informes en ninguna aplicación', () => {
    const op = systemRolePermissionKeys('OPERADOR')
    expect(op).toContain('pedido.read')
    expect(op).toContain('pedido.complete')
    // "no, reportes no, pedidos nada más, como está hasta ahora está correcto"
    // (Jose, 11/08). Así funciona hoy en PEDIDO, y cambiarlo aquí lo cambiaría
    // allí en cuanto PEDIDO empiece a leer los permisos de este login.
    expect(op).not.toContain('pedido.import')
    expect(op).not.toContain('reporte.read')
    expect(op).not.toContain('analitics.read')
    expect(op).not.toContain('ccsa.read')
  })

  it('el Gestor solo lee, y ni siquiera puede completar un pedido', () => {
    const gestor = systemRolePermissionKeys('GESTOR')
    expect(gestor).toContain('pedido.read')
    expect(gestor).not.toContain('pedido.complete')
    expect(gestor).not.toContain('vendedor.manage')
  })

  it('cada rol da al menos lo que da el de debajo', () => {
    // Un Supervisor que no pudiera hacer algo que sí puede un Operador sería un
    // sinsentido que además nadie notaría hasta que alguien se queja.
    //
    // `vendedor.codigo` queda FUERA de esta comprobación a propósito: no es un
    // permiso de "puede hacer", marca QUIÉN VENDE. El Gestor vende y el Operador
    // no, así que la cadena se rompe ahí sin que nada esté mal. Sin esta
    // exclusión el test fallaba —y llevaba fallando— por un motivo que no era
    // un fallo.
    const NO_ES_PODER = new Set(['vendedor.codigo'])
    const orden = ['GESTOR', 'OPERADOR', 'SUPERVISOR', 'ADMINISTRADOR', 'SUPER ADMIN', 'DESARROLLADOR']
    for (let i = 1; i < orden.length; i++) {
      const menor = systemRolePermissionKeys(orden[i - 1]).filter((k) => !NO_ES_PODER.has(k))
      const mayor = new Set(systemRolePermissionKeys(orden[i]))
      for (const k of menor) {
        expect(mayor.has(k), `${orden[i]} debería incluir ${k} (lo tiene ${orden[i - 1]})`).toBe(true)
      }
    }
  })

  it('ningún rol da un permiso que no exista', () => {
    const catalogo = new Set(PERMISSION_CATALOG.map((p) => p.key))
    for (const nombre of SYSTEM_ROLE_NAMES) {
      for (const k of systemRolePermissionKeys(nombre)) {
        expect(catalogo.has(k), `${nombre} da "${k}", que no está en el catálogo`).toBe(true)
      }
    }
  })

  it('un rol desconocido no da nada', () => {
    expect(systemRolePermissionKeys('lo-que-sea')).toEqual([])
  })

  it('el rol por defecto es el más limitado', () => {
    expect(ROL_MINIMO).toBe('GESTOR')
    expect(PRECEDENCE[0]).toBe('DESARROLLADOR')
  })
})
