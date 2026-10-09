/**
 * El editor de perfil toma sus valores iniciales de `user` al montarse. Si se monta sin
 * `user` (todavía no llegó, o `refreshUser` falló) queda con los campos vacíos para siempre,
 * y un «guardar» con campos vacíos pisaría los datos. Solo se monta cuando hay `user`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const fuente = readFileSync(path.join(process.cwd(), 'src/components/profile/personal/mi-perfil-secciones.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('mi-perfil-secciones', () => {
    it('monta el editor solo si hay user, con su id como key', () => {
        expect(fuente).toContain('{user && <ProfileEditor key={user.id} />}')
    })

    it('no lo monta nunca de forma incondicional', () => {
        expect(fuente.match(/<ProfileEditor/g)).toHaveLength(1)
        expect(fuente).not.toContain('"cargando"')
    })
})
