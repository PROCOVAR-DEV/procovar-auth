/**
 * «Marcar todo como leído»: una a una, con tope de avisos y de paralelismo, y contando
 * lo que falla (para decírselo a la persona en vez de callarlo).
 */
import { describe, it, expect, vi } from 'vitest'
import { EN_PARALELO, MARCAR_MAX, marcarVarios } from '../marcar-varios'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)

describe('marcarVarios', () => {
    it('marca todos y no falla ninguno', async () => {
        const marcar = vi.fn(async () => true)
        expect(await marcarVarios(ids(7), marcar)).toEqual({ hechos: 7, fallidos: 0 })
        expect(marcar).toHaveBeenCalledTimes(7)
    })

    it('cuenta los que fallan, sea por false o por excepción', async () => {
        const marcar = async (id: string) => {
            if (id === 'a2') return false
            if (id === 'a4') throw new Error('red caída')
            return true
        }
        expect(await marcarVarios(ids(5), marcar)).toEqual({ hechos: 3, fallidos: 2 })
    })

    it('tope: nunca más de MARCAR_MAX por pulsación', async () => {
        const marcar = vi.fn(async () => true)
        const r = await marcarVarios(ids(MARCAR_MAX + 30), marcar)
        expect(marcar).toHaveBeenCalledTimes(MARCAR_MAX)
        expect(r).toEqual({ hechos: MARCAR_MAX, fallidos: 0 })
    })

    it('tope configurable', async () => {
        const marcar = vi.fn(async () => true)
        await marcarVarios(ids(10), marcar, 3)
        expect(marcar).toHaveBeenCalledTimes(3)
    })

    it('paralelismo: nunca más de EN_PARALELO a la vez', async () => {
        let vivas = 0
        let maximo = 0
        const marcar = async () => {
            vivas++
            maximo = Math.max(maximo, vivas)
            await new Promise((r) => setTimeout(r, 2))
            vivas--
            return true
        }
        await marcarVarios(ids(23), marcar)
        expect(maximo).toBe(EN_PARALELO)
    })

    it('sin avisos no llama a nada', async () => {
        const marcar = vi.fn(async () => true)
        expect(await marcarVarios([], marcar)).toEqual({ hechos: 0, fallidos: 0 })
        expect(marcar).not.toHaveBeenCalled()
    })
})
