/**
 * El menú lateral enciende UN apartado. Antes, en /profile/org salían encendidos a la vez
 * «Mi cuenta» (/profile) y «Mi sucursal» (/profile/org).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { apartadoActivo } from '../apartado-activo'

// Los href del menú de una persona de sucursal y los de un Super Admin.
const SUCURSAL = ['/', '/profile/org', '/profile']
const GLOBAL = ['/', '/dashboard/organizations', '/dashboard/users', '/dashboard/permissions', '/dashboard/auditoria', '/apikeys', '/profile']

describe('apartadoActivo', () => {
    it('/profile/org enciende solo «Mi sucursal», no «Mi cuenta»', () => {
        expect(apartadoActivo('/profile/org', SUCURSAL)).toBe('/profile/org')
        expect(apartadoActivo('/profile/org/algo', SUCURSAL)).toBe('/profile/org')
    })

    it('/profile y sus subrutas sin apartado propio encienden «Mi cuenta»', () => {
        expect(apartadoActivo('/profile', SUCURSAL)).toBe('/profile')
        expect(apartadoActivo('/profile/notifications', SUCURSAL)).toBe('/profile')
        expect(apartadoActivo('/profile/notifications/abc', GLOBAL)).toBe('/profile')
    })

    it('es el mismo resultado sin importar el orden de los apartados', () => {
        expect(apartadoActivo('/profile/org', [...SUCURSAL].reverse())).toBe('/profile/org')
    })

    it('la raíz solo casa consigo misma', () => {
        expect(apartadoActivo('/', SUCURSAL)).toBe('/')
        expect(apartadoActivo('/profile', ['/'])).toBeNull()
    })

    it('subruta con barra, no prefijo suelto: /profile-otra no es /profile', () => {
        expect(apartadoActivo('/profile-otra', SUCURSAL)).toBeNull()
        expect(apartadoActivo('/dashboard/users2', GLOBAL)).toBeNull()
    })

    it('una ruta de administración enciende la suya', () => {
        expect(apartadoActivo('/dashboard/users/123', GLOBAL)).toBe('/dashboard/users')
        expect(apartadoActivo('/apikeys', GLOBAL)).toBe('/apikeys')
    })

    it('una ruta sin apartado no enciende ninguno', () => {
        expect(apartadoActivo('/otra/cosa', GLOBAL)).toBeNull()
    })

    it('sin apartados, ninguno', () => {
        expect(apartadoActivo('/profile', [])).toBeNull()
    })
})

describe('el armazón usa la función y marca el activo', () => {
    const fuente = readFileSync(path.join(process.cwd(), 'src/components/layout/armazon.tsx'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')

    it('usa apartadoActivo sobre los apartados VISIBLES y pone aria-current="page" al activo', () => {
        expect(fuente).toContain('apartadoActivo(')
        expect(fuente).toContain('visibles.map((a) => a.href)')
        expect(fuente).toContain('data-activo={a.href === activo}')
        expect(fuente).toContain('aria-current={a.href === activo ? "page" : undefined}')
    })
})
