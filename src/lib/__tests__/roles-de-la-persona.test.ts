import { describe, it, expect } from 'vitest'
import { SUPER_ADMIN, rolesFirmados, rolPrincipal } from '@/lib/roles-de-la-persona'

/**
 * Los roles que Accesos FIRMA para Reparto (APK y web). Lo que se prueba es lo que decide
 * quién entra: si `SUPER ADMIN` se añade, a quién, y que no se repita ni se invente.
 */
describe('rolesFirmados', () => {
    it('quita los repetidos y no añade nada a quien no es administrador del sistema', () => {
        expect(rolesFirmados(['LOGISTICO', 'LOGISTICO', 'GESTOR'], false)).toEqual(['LOGISTICO', 'GESTOR'])
    })

    it('a una cuenta isSystemAdmin sin roles le añade SUPER ADMIN', () => {
        expect(rolesFirmados([], true)).toEqual([SUPER_ADMIN])
    })

    it('si ya lo trae no se repite, aunque venga con otras mayúsculas o con espacios', () => {
        expect(rolesFirmados(['SUPER ADMIN'], true)).toEqual(['SUPER ADMIN'])
        expect(rolesFirmados(['super admin '], true)).toEqual(['super admin '])
    })

    it('se suma al final y no desplaza a los demás', () => {
        expect(rolesFirmados(['LOGISTICO'], true)).toEqual(['LOGISTICO', SUPER_ADMIN])
    })

    it('un administrador de sistema NO es lo mismo que cualquiera: sin el flag no se añade nunca', () => {
        expect(rolesFirmados([], false)).toEqual([])
    })
})

describe('rolPrincipal', () => {
    it('es el rol por defecto, aunque la cuenta sea de administrador del sistema', () => {
        expect(rolPrincipal('LOGISTICO', true)).toBe('LOGISTICO')
    })

    it('sin rol por defecto, una cuenta isSystemAdmin sale como SUPER ADMIN', () => {
        expect(rolPrincipal(null, true)).toBe(SUPER_ADMIN)
        expect(rolPrincipal(undefined, true)).toBe(SUPER_ADMIN)
    })

    it('sin rol por defecto y sin ser administrador es null: no se escoge «el primero que salga»', () => {
        expect(rolPrincipal(null, false)).toBeNull()
        expect(rolPrincipal(undefined, false)).toBeNull()
    })
})
