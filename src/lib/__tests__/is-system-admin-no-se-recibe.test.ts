import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * EL REGISTRO PÚBLICO NO PUEDE FABRICAR UN SUPER ADMIN — 08/10/2026.
 *
 * Auditoría de seguridad: `user.additionalFields.isSystemAdmin` estaba declarado sin
 * `input: false`, y `POST /api/auth/sign-up/email` (abierto: `emailAndPassword` activo y sin
 * `disableSignUp`) con `isSystemAdmin: true` en el cuerpo guardaba la cuenta como
 * administradora del sistema. Ese flag da el comodín en todas las aplicaciones y, desde el
 * 08/10, `SUPER ADMIN` firmado en los tokens de Reparto.
 *
 * Es una prueba de TEXTO: better-auth no se levanta aquí. Vigila que nadie quite el
 * `input: false` sin que algo lo diga. Quien marca el flag de verdad lo hace con Prisma
 * directo, que no pasa por `input`.
 */
describe('isSystemAdmin no se acepta desde el cuerpo de una petición', () => {
    const fuente = readFileSync(join(__dirname, '..', 'auth.ts'), 'utf8')
    const bloque = /isSystemAdmin:\s*\{([^}]*)\}/.exec(fuente)

    it('el campo está declarado en additionalFields', () => {
        expect(bloque, 'no se encontró `isSystemAdmin: { ... }` en auth.ts: si lo moviste, actualiza esta prueba').not.toBeNull()
    })

    it('lleva `input: false`', () => {
        expect(bloque?.[1]).toMatch(/input:\s*false/)
    })

    it('y su valor por defecto es false', () => {
        expect(bloque?.[1]).toMatch(/defaultValue:\s*false/)
    })
})
