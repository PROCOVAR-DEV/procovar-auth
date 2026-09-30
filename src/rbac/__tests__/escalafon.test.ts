/**
 * El techo de quien reparte accesos, en pareja: lo que SÍ y lo que NO.
 *
 * Cada regla se prueba por los dos lados a propósito. Una prueba que sólo
 * comprueba el "sí" pasa igual de verde con la guarda quitada.
 */
import { describe, it, expect } from 'vitest'
import { puedeRepartirRol, rolesRepartibles, rangoDeRol, rangoDelActor, ESCALAFON } from '../escalafon'
import { systemRolePermissionKeys, SYSTEM_ROLE_NAMES } from '../system-roles'
import type { ResolvedRbac } from '../types'

/** Un actor con exactamente lo que da su rol del catálogo. */
function actor(rol: string): ResolvedRbac {
  return { org: 'cam', wildcard: false, global: systemRolePermissionKeys(rol) }
}

/** El rol tal y como lo sembraría el catálogo. */
function rol(nombre: string) {
  return { name: nombre, claves: systemRolePermissionKeys(nombre) }
}

const ADMIN = actor('ADMINISTRADOR')
const SUPER: ResolvedRbac = { org: null, wildcard: true, global: [] }

describe('el escalafón', () => {
  it('son los NUEVE roles, y en orden de más poder a menos', () => {
    expect([...ESCALAFON]).toEqual([...SYSTEM_ROLE_NAMES])
    expect(ESCALAFON).toHaveLength(9)
    expect(rangoDeRol('DESARROLLADOR')).toBeLessThan(rangoDeRol('SUPER ADMIN')!)
    expect(rangoDeRol('SUPER ADMIN')).toBeLessThan(rangoDeRol('ADMINISTRADOR')!)
    expect(rangoDeRol('ADMINISTRADOR')).toBeLessThan(rangoDeRol('GERENTE')!)
    expect(rangoDeRol('GERENTE')).toBeLessThan(rangoDeRol('SUPERVISOR')!)
    expect(rangoDeRol('SUPERVISOR')).toBeLessThan(rangoDeRol('GESTOR')!)
    expect(rangoDeRol('GESTOR')).toBeLessThan(rangoDeRol('OPERADOR')!)
    // Los dos de oficio van debajo de todo: no mandan sobre nadie.
    expect(rangoDeRol('OPERADOR')).toBeLessThan(rangoDeRol('ECONOMICA')!)
    expect(rangoDeRol('ECONOMICA')).toBeLessThan(rangoDeRol('ANALISTA')!)
  })

  it('un rol hecho a mano no está en el escalafón', () => {
    expect(rangoDeRol('COBRADOR DE LOS MARTES')).toBeNull()
  })

  it('con varios roles vale el MÁS ALTO, venga en el orden que venga', () => {
    expect(rangoDelActor(['GESTOR', 'ADMINISTRADOR'])).toBe(rangoDeRol('ADMINISTRADOR'))
    expect(rangoDelActor(['ADMINISTRADOR', 'GESTOR'])).toBe(rangoDeRol('ADMINISTRADOR'))
    expect(rangoDelActor(['inventado'])).toBeNull()
  })
})

describe('un ADMINISTRADOR repartiendo roles', () => {
  const mios = ['ADMINISTRADOR']

  // El SÍ: los cuatro de debajo. GESTOR y SUPERVISOR son los que Jose llama
  // "vendedores" —llevan `vendedor.codigo`, que el administrador NO tiene—, así
  // que si esto falla es que la regla de las claves se está comiendo el encargo.
  it.each(['GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR', 'ECONOMICA', 'ANALISTA'])('SÍ puede dar %s', (nombre) => {
    expect(puedeRepartirRol(ADMIN, mios, rol(nombre))).toBe(true)
  })

  // El NO: el suyo y los dos de arriba.
  it.each(['SUPER ADMIN', 'DESARROLLADOR'])('NO puede dar %s', (nombre) => {
    expect(puedeRepartirRol(ADMIN, mios, rol(nombre))).toBe(false)
  })

  it('NO puede dar ADMINISTRADOR: clonarse no es repartir', () => {
    expect(puedeRepartirRol(ADMIN, mios, rol('ADMINISTRADOR'))).toBe(false)
  })

  it('`vendedor.codigo` no cuenta como poder — es lo que deja crear vendedores', () => {
    expect(ADMIN.global).not.toContain('vendedor.codigo')
    expect(systemRolePermissionKeys('GESTOR')).toContain('vendedor.codigo')
    expect(puedeRepartirRol(ADMIN, mios, rol('GESTOR'))).toBe(true)
  })

  it('un rol de debajo al que alguien le colgó un permiso de más, tampoco', () => {
    // Los roles se editan desde la pantalla de Permisos. El escalafón solo no
    // vería esto: hace falta seguir mirando las claves.
    const gestorTocado = { name: 'GESTOR', claves: [...systemRolePermissionKeys('GESTOR'), 'app.manage'] }
    expect(ADMIN.global).not.toContain('app.manage')
    expect(puedeRepartirRol(ADMIN, mios, gestorTocado)).toBe(false)
  })

  it('un rol hecho a mano: sólo si sus claves caben en las suyas', () => {
    expect(puedeRepartirRol(ADMIN, mios, { name: 'AYUDANTE', claves: ['pedido.read'] })).toBe(true)
    expect(puedeRepartirRol(ADMIN, mios, { name: 'AYUDANTE', claves: ['app.manage'] })).toBe(false)
    // Fuera del escalafón no se perdona el marcador: ahí no sabemos qué significa.
    expect(puedeRepartirRol(ADMIN, mios, { name: 'AYUDANTE', claves: ['vendedor.codigo'] })).toBe(false)
  })

  it('el desplegable sólo le ofrece los de debajo', () => {
    const catalogo = SYSTEM_ROLE_NAMES.map((n) => ({ id: n, ...rol(n) }))
    // ECONOMICA y ANALISTA entran aquí desde el 30/09/2026. La primera es de una
    // sucursal —el AFT de la suya—, así que un administrador la reparte igual que
    // reparte un operador. La segunda hoy está VACÍA, así que darla no abre nada;
    // el día que vea varias sucursales hay que subirla de sitio, y está avisado en
    // system-roles.ts.
    expect(rolesRepartibles(ADMIN, mios, catalogo).map((r) => r.name)).toEqual([
      'GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR', 'ECONOMICA', 'ANALISTA',
    ])
  })
})

describe('los demás', () => {
  it('el SUPER ADMIN (comodín) reparte cualquiera', () => {
    for (const n of SYSTEM_ROLE_NAMES) {
      expect(puedeRepartirRol(SUPER, [], rol(n))).toBe(true)
    }
  })

  it('un GERENTE no reparte: no tiene member.invite, y aun así el techo lo para', () => {
    const gerente = actor('GERENTE')
    expect(gerente.global).not.toContain('member.invite')
    expect(puedeRepartirRol(gerente, ['GERENTE'], rol('ADMINISTRADOR'))).toBe(false)
    expect(puedeRepartirRol(gerente, ['GERENTE'], rol('GESTOR'))).toBe(true)
  })

  it('sin rol del escalafón no reparte ninguno del escalafón', () => {
    // Aunque le sobraran permisos: sin rango no hay techo que calcular.
    const suelto: ResolvedRbac = { org: 'cam', wildcard: false, global: systemRolePermissionKeys('SUPER ADMIN') }
    expect(puedeRepartirRol(suelto, [], rol('OPERADOR'))).toBe(false)
  })

  it('sin rbac no reparte nada: negar por defecto', () => {
    expect(puedeRepartirRol(null, ['SUPER ADMIN'], rol('OPERADOR'))).toBe(false)
    expect(puedeRepartirRol(undefined, ['SUPER ADMIN'], rol('OPERADOR'))).toBe(false)
  })
})
