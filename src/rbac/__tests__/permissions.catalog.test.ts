import { describe, it, expect } from 'vitest'
import { PERMISSION_CATALOG } from '../permissions.catalog'

const SERVICIOS = ['pedido', 'analitics', 'delivery', 'ccsa', 'auth', 'rutas', 'avisos', 'aft']

describe('el catálogo de permisos', () => {
  it('no repite claves', () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('cada permiso dice de qué aplicación es', () => {
    // `service` es lo que permite que el Operador sí vea reportes en analitics y
    // no en PEDIDO. Sin él volvemos a un único interruptor para las cuatro apps.
    for (const p of PERMISSION_CATALOG) {
      expect(SERVICIOS, `"${p.key}" es del servicio "${p.service}"`).toContain(p.service)
    }
  })

  it('todas las aplicaciones tienen permisos', () => {
    for (const s of SERVICIOS) {
      expect(PERMISSION_CATALOG.some((p) => p.service === s), `falta ${s}`).toBe(true)
    }
  })

  it('la clave es recurso.acción, y así se guarda', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.key.split('.'), `"${p.key}"`).toHaveLength(2)
      expect(p.key).toBe(`${p.resource}.${p.action}`)
    }
  })

  it('están los que Jose pidió expresamente', () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key)
    // La auditoría ("saber qué se hizo en cada cliente") y el alta de las
    // aplicaciones externas fueron peticiones suyas, no adornos.
    expect(keys).toContain('audit.read')
    expect(keys).toContain('app.manage')
    expect(keys).toContain('member.assignRole')
  })

  it('todo permiso se puede enseñar en pantalla', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.label.es, p.key).toBeTruthy()
      expect(p.label.en, p.key).toBeTruthy()
      expect(p.group, p.key).toBeTruthy()
    }
  })
})
