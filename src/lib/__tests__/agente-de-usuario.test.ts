import { describe, it, expect } from 'vitest'
import { describirAgente } from '@/lib/agente-de-usuario'

describe('describirAgente', () => {
    it('un navegador se dice «Navegador en Sistema»', () => {
        const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        expect(describirAgente(ua)).toMatchObject({ texto: 'Chrome en Linux', tipo: 'navegador' })
    })

    it('el navegador de un teléfono sigue siendo un navegador (lo decide el cliente, no el hardware)', () => {
        const ua = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        expect(describirAgente(ua)).toMatchObject({ texto: 'Chrome en Android', tipo: 'navegador' })
    })

    it('el User-Agent de Dart es un aparato, y no inventa la plataforma', () => {
        expect(describirAgente('Dart/3.5 (dart:io)')).toMatchObject({ texto: 'App de Reparto', tipo: 'aparato', sistema: null })
    })

    it('si la app manda su propio agente con la plataforma, se entiende sin cambios', () => {
        expect(describirAgente('ProcovarReparto/1.4 (Android 14)')).toMatchObject({
            texto: 'App de Reparto en Android',
            tipo: 'aparato',
        })
    })

    it('sin agente, o con uno que no se reconoce, no se inventa un navegador', () => {
        expect(describirAgente(null)).toMatchObject({ tipo: 'desconocido', texto: 'Dispositivo sin identificar' })
        expect(describirAgente('   ')).toMatchObject({ tipo: 'desconocido' })
        expect(describirAgente('curl/8.4')).toMatchObject({ tipo: 'desconocido' })
    })
})
