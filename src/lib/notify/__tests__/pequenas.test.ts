/** Piezas pequeñas y puras de los avisos: la etiqueta «100+», marcar leído UNA vez, y las rutas. */
import { describe, it, expect, vi } from 'vitest'
import { etiquetaSinLeer, PANEL_FETCH_LIMIT } from '../panel'
import { marcarLeidoUnaVez } from '../marcar-una-vez'
import { destinoAviso, rutaDetalle } from '../format'

describe('etiquetaSinLeer: nunca un número que infravalore', () => {
    it('por debajo del tope el número es exacto', () => {
        expect(etiquetaSinLeer(3, 40)).toBe('3')
        expect(etiquetaSinLeer(99, 99)).toBe('99')
    })
    it('con la lista al tope es una cota: «100+» si están todos sin leer, «N+» si no', () => {
        expect(PANEL_FETCH_LIMIT).toBe(100)
        expect(etiquetaSinLeer(100, 100)).toBe('100+')
        expect(etiquetaSinLeer(3, 100)).toBe('3+')
        expect(etiquetaSinLeer(0, 100)).toBe('0+')
    })
})

describe('marcarLeidoUnaVez: sin bucle', () => {
    const aviso = { id: 'a1', readAt: null }

    /** Lo que hace React: mientras `readAt` siga nulo, el efecto vuelve a disparar. */
    const simularEfecto = async (vueltas: number, marcar: (id: string) => Promise<boolean>, recargar: () => Promise<void>) => {
        const intentados = new Set<string>()
        for (let i = 0; i < vueltas; i++) await marcarLeidoUnaVez(aviso, intentados, marcar, recargar)
    }

    it('el POST falla y el GET sigue devolviendo readAt nulo: se intenta UNA vez, no 50', async () => {
        const marcar = vi.fn().mockResolvedValue(false)
        const recargar = vi.fn().mockResolvedValue(undefined)
        await simularEfecto(50, marcar, recargar)
        expect(marcar).toHaveBeenCalledTimes(1)
        expect(recargar).not.toHaveBeenCalled() // no se recarga si el POST no dijo que sí
    })

    it('el POST lanza: cuenta como fallo, una sola vez, sin romper', async () => {
        const marcar = vi.fn().mockRejectedValue(new Error('red'))
        const recargar = vi.fn()
        await simularEfecto(10, marcar, recargar)
        expect(marcar).toHaveBeenCalledTimes(1)
        expect(recargar).not.toHaveBeenCalled()
    })

    it('el POST va bien: marca y recarga una vez, y aunque readAt siga nulo no repite', async () => {
        const marcar = vi.fn().mockResolvedValue(true)
        const recargar = vi.fn().mockResolvedValue(undefined)
        await simularEfecto(50, marcar, recargar)
        expect(marcar).toHaveBeenCalledTimes(1)
        expect(recargar).toHaveBeenCalledTimes(1)
    })

    it('cada id tiene su propio intento; leído o inexistente se omite', async () => {
        const marcar = vi.fn().mockResolvedValue(true)
        const recargar = vi.fn().mockResolvedValue(undefined)
        const intentados = new Set<string>()
        expect(await marcarLeidoUnaVez({ id: 'a', readAt: null }, intentados, marcar, recargar)).toBe('marcado')
        expect(await marcarLeidoUnaVez({ id: 'b', readAt: null }, intentados, marcar, recargar)).toBe('marcado')
        expect(await marcarLeidoUnaVez({ id: 'c', readAt: '2026-10-01' }, intentados, marcar, recargar)).toBe('omitido')
        expect(await marcarLeidoUnaVez(null, intentados, marcar, recargar)).toBe('omitido')
        expect(marcar.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    })
})

describe('adónde lleva un aviso', () => {
    it('el detalle codifica el id: viene de otro servicio y no puede salirse de la ruta', () => {
        expect(rutaDetalle('a1')).toBe('/profile/notifications/a1')
        expect(rutaDetalle('../x?y=1#z')).toBe('/profile/notifications/..%2Fx%3Fy%3D1%23z')
        expect(destinoAviso({ id: 'a/b', href: null })).toBe('/profile/notifications/a%2Fb')
        expect(destinoAviso({ id: 'a1' })).toBe('/profile/notifications/a1')
    })
    it('con destino propio, ese', () => {
        expect(destinoAviso({ id: 'a1', href: '/profile/invoices/F1' })).toBe('/profile/invoices/F1')
    })
})
