/**
 * El historial en cada uno de sus estados. La lista (`ListaDeInicios`) es solo presentación: se
 * pinta a HTML (no hay navegador en estas pruebas) con los textos REALES de `messages/es.json` y
 * `en.json`, como el panel de la campana. El estado que decide qué se ve (`reducir`) es una
 * función pura y se ejecuta. Lo que necesita un navegador de verdad (el foco, el fetch) se
 * vigila en el fuente.
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import es from '../../../../../messages/es.json'
import en from '../../../../../messages/en.json'
import { ListaDeInicios, estadoInicial, reducir, type PropsDeLaLista } from '../historial-de-inicios'
import type { FilaDeInicio, PaginaDeInicios } from '@/lib/historial-de-inicios'

const bruto = readFileSync(path.join(process.cwd(), 'src/components/profile/personal/historial-de-inicios.tsx'), 'utf8')
const fuente = bruto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const fila = (n: number, extra: Partial<FilaDeInicio> = {}): FilaDeInicio => ({
    id: `f${n}`,
    cuando: '2026-10-08T12:00:00.000Z',
    tipo: 'navegador',
    ip: `10.0.0.${n}`,
    ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36',
    estaActiva: null,
    esActual: false,
    ...extra,
})
const pagina = (filas: number, p: Partial<PaginaDeInicios> = {}): PaginaDeInicios => ({
    filas: Array.from({ length: filas }, (_, i) => fila(i + 1)),
    pagina: 1,
    paginas: 1,
    total: filas,
    porPagina: 10,
    ...p,
})
const tres = pagina(10, { pagina: 1, paginas: 3, total: 25 })

const base: PropsDeLaLista = { datos: null, cargando: false, error: false, pedida: 1, onPage: vi.fn(), onRetry: vi.fn() }
const pintar = (props: Partial<PropsDeLaLista>, mensajes: object = es, locale = 'es') =>
    renderToStaticMarkup(
        createElement(
            NextIntlClientProvider,
            { locale, messages: mensajes, timeZone: 'UTC' } as never,
            createElement(ListaDeInicios, { ...base, ...props }) as ReactElement,
        ),
    )

const boton = (html: string, etiqueta: string) => html.match(new RegExp(`<button[^>]*aria-label="${etiqueta}"[^>]*>`))?.[0] ?? ''
const apagado = (b: string) => /\saria-disabled="true"/.test(b)
const conDisabled = (b: string) => /\sdisabled(=""|\s|>)/.test(b)

describe('ListaDeInicios: estados', () => {
    it('primera carga: lo dice y no enseña ni el vacío ni los controles', () => {
        const html = pintar({ cargando: true })
        expect(html).toContain('role="status"')
        expect(html).toContain('Buscando los inicios de sesión')
        expect(html).not.toContain('Todavía no hay')
        expect(html).not.toContain('Página')
    })

    it('sin inicios: «Todavía no hay…», sin lista ni controles', () => {
        const html = pintar({ datos: pagina(0) })
        expect(html).toContain('Todavía no hay inicios de sesión')
        expect(html).not.toContain('<li')
        expect(html).not.toContain('<nav')
    })

    it('error en la primera carga: aviso con «Reintentar», y no dice que esté vacío', () => {
        const html = pintar({ error: true })
        expect(html).toContain('role="alert"')
        expect(html).toContain('No se pudo cargar el historial')
        expect(html).toContain('Reintentar')
        expect(html).not.toContain('Todavía no hay')
        expect(html).not.toContain('<nav')
    })

    it('con una sola página NO hay controles (ni «Página 1 de 1»)', () => {
        for (const filas of [1, 7, 10]) {
            const html = pintar({ datos: pagina(filas) })
            expect(html.match(/<li/g)).toHaveLength(filas)
            expect(html).not.toContain('<nav')
            expect(html).not.toContain('Página')
            expect(html).not.toContain('aria-live')
        }
    })

    it('con varias: diez filas, «Página 1 de 3», anterior apagado y siguiente activo', () => {
        const html = pintar({ datos: tres })
        expect(html.match(/<li/g)).toHaveLength(10)
        expect(html).toContain('Página 1 de 3')
        expect(html).toContain('<nav aria-label="Paginación del historial de inicios de sesión"')
        expect(apagado(boton(html, 'Página anterior'))).toBe(true)
        expect(apagado(boton(html, 'Página siguiente'))).toBe(false)
    })

    it('en la última, siguiente apagado y anterior activo; en la del medio, los dos activos', () => {
        const ultima = pintar({ datos: pagina(5, { pagina: 3, paginas: 3, total: 25 }) })
        expect(ultima).toContain('Página 3 de 3')
        expect(apagado(boton(ultima, 'Página siguiente'))).toBe(true)
        expect(apagado(boton(ultima, 'Página anterior'))).toBe(false)
        const medio = pintar({ datos: pagina(10, { pagina: 2, paginas: 3, total: 25 }) })
        expect(apagado(boton(medio, 'Página anterior'))).toBe(false)
        expect(apagado(boton(medio, 'Página siguiente'))).toBe(false)
    })

    it('como en la campana: aria-disabled y nunca `disabled`, y aria-live sólo en «Página X de Y»', () => {
        for (const props of [{ datos: tres }, { datos: pagina(5, { pagina: 3, paginas: 3 }) }, { datos: tres, cargando: true }]) {
            const html = pintar(props)
            expect(conDisabled(boton(html, 'Página anterior'))).toBe(false)
            expect(conDisabled(boton(html, 'Página siguiente'))).toBe(false)
            expect(html.match(/aria-live=/g)).toHaveLength(1)
        }
        expect(pintar({ datos: tres })).toMatch(/aria-live="polite"[^>]*>Página 1 de 3/)
    })

    it('cambiar de página NO vacía la sección: la anterior sigue, atenuada y con aria-busy, sin «Cargando…»', () => {
        const html = pintar({ datos: tres, cargando: true, pedida: 2 })
        expect(html.match(/<li/g)).toHaveLength(10)
        expect(html).toContain('aria-busy="true"')
        expect(html).toMatch(/aria-busy="true" class="[^"]*opacity-50/)
        expect(html).not.toContain('Buscando los inicios')
        expect(html).toContain('Página 1 de 3')
        // Quieta, ni atenuada ni ocupada.
        const quieta = pintar({ datos: tres })
        expect(quieta).toContain('aria-busy="false"')
        expect(quieta).not.toContain('opacity-50')
    })

    it('error al cambiar de página: avisa de CUÁL, con «Reintentar», y no pierde lo ya visto', () => {
        const html = pintar({ datos: tres, error: true, pedida: 2 })
        expect(html).toContain('role="alert"')
        expect(html).toContain('No se pudo cargar la página 2. Sigues viendo la anterior.')
        expect(html).toContain('Reintentar')
        expect(html.match(/<li/g)).toHaveLength(10)
        expect(html).toContain('Página 1 de 3')
        expect(html).not.toContain('opacity-50')
    })

    it('la cabecera admite el foco al cambiar de página (tabIndex -1) y conserva su id', () => {
        expect(pintar({ datos: tres })).toMatch(/<h2 id="historial-titulo" tabindex="-1"/)
    })

    it('las filas siguen diciendo qué son: esta sesión, abierta, cerrada, aparato, IP sin registrar', () => {
        const html = pintar({
            datos: pagina(0, {
                filas: [fila(1, { esActual: true, estaActiva: true }), fila(2, { estaActiva: true }), fila(3, { estaActiva: false }), fila(4, { tipo: 'aparato', ua: 'Dart/3.5 (dart:io)', ip: null })],
                total: 4,
            }),
        })
        for (const texto of ['Esta sesión', 'Sigue abierta', 'Cerrada', 'App de Reparto', 'IP sin registrar', 'IP 10.0.0.1']) expect(html).toContain(texto)
    })

    it('en inglés: mismos controles, sus textos', () => {
        const html = pintar({ datos: tres }, en, 'en')
        expect(html).toContain('Page 1 of 3')
        expect(html).toContain('Sign-in history pagination')
        expect(apagado(boton(html, 'Previous page'))).toBe(true)
        expect(apagado(boton(html, 'Next page'))).toBe(false)
        expect(pintar({ datos: tres, error: true, pedida: 4 }, en, 'en')).toContain('Page 4 could not be loaded. You are still seeing the previous one.')
    })

    it('a 390 px nada desborda: nombres con break-words, IPv6 largas con break-all, filas min-w-0, nav que no se parte', () => {
        const html = pintar({ datos: pagina(1, { paginas: 3, total: 25, filas: [fila(1, { ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' })] }) })
        expect(html).toMatch(/min-w-0 break-words/)
        expect(html).toMatch(/break-all/)
        expect(html).toMatch(/<div class="min-w-0 flex-1">/)
        expect(html).toMatch(/<nav [^>]*class="flex items-center justify-between gap-2"/)
        expect(html).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/)
    })
})

describe('reducir: lo ya visto no se pierde', () => {
    const p1 = pagina(10, { pagina: 1, paginas: 3, total: 25 })
    const p2 = pagina(10, { pagina: 2, paginas: 3, total: 25 })

    it('empieza cargando la primera, sin datos', () => {
        expect(estadoInicial).toMatchObject({ datos: null, pedida: 1, cargando: true, error: false })
    })

    it('pedir otra página conserva los datos y los atenúa (cargando), sin error', () => {
        const e = reducir(reducir(estadoInicial, { tipo: 'llego', datos: p1 }), { tipo: 'pedir', pagina: 2 })
        expect(e).toMatchObject({ datos: p1, pedida: 2, cargando: true, error: false })
    })

    it('al llegar, la nueva sustituye a la anterior', () => {
        const e = [{ tipo: 'llego', datos: p1 }, { tipo: 'pedir', pagina: 2 }, { tipo: 'llego', datos: p2 }].reduce(
            (s, a) => reducir(s, a as never),
            estadoInicial,
        )
        expect(e).toMatchObject({ datos: p2, pedida: 2, cargando: false, error: false })
    })

    it('si falla, los datos siguen ahí y sale el error (con la página que falló)', () => {
        const e = [{ tipo: 'llego', datos: p1 }, { tipo: 'pedir', pagina: 2 }, { tipo: 'fallo' }].reduce(
            (s, a) => reducir(s, a as never),
            estadoInicial,
        )
        expect(e).toMatchObject({ datos: p1, pedida: 2, cargando: false, error: true })
        // Y si falla la primera, no hay datos que conservar: la lista no inventa nada.
        expect(reducir(estadoInicial, { tipo: 'fallo' })).toMatchObject({ datos: null, error: true, cargando: false })
    })

    it('«Reintentar» vuelve a pedir la MISMA página: el intento sube para que el efecto repita la petición', () => {
        const fallado = reducir(reducir(estadoInicial, { tipo: 'pedir', pagina: 2 }), { tipo: 'fallo' })
        const otra = reducir(fallado, { tipo: 'pedir', pagina: fallado.pedida })
        expect(otra).toMatchObject({ pedida: 2, cargando: true, error: false })
        expect(otra.intento).toBeGreaterThan(fallado.intento)
    })
})

describe('historial-de-inicios.tsx (lo que pide un navegador de verdad)', () => {
    it('lo pide a /api/user/historial?pagina=, sin mandar quién es', () => {
        expect(fuente).toContain('/api/user/historial?pagina=${e.pedida}')
        expect(fuente).not.toMatch(/userId|user\.id/)
    })

    it('ya no hay cursor ni «Ver más»: nada de `desde`, `siguiente`, `verMas` ni `errorMas`', () => {
        expect(fuente).not.toMatch(/\bdesde\b|setSiguiente|\.siguiente\b|t\("verMas"\)|errorMas|cargandoMas|falloMas/)
        for (const mensajes of [es, en] as Record<string, Record<string, unknown>>[]) {
            expect(mensajes.historial).not.toHaveProperty('verMas')
            expect(mensajes.historial).not.toHaveProperty('errorMas')
        }
    })

    it('de lib sólo importa tipos del historial (nada de Prisma en el navegador)', () => {
        expect(fuente).toContain('import type { FilaDeInicio, PaginaDeInicios } from "@/lib/historial-de-inicios"')
        expect(fuente).not.toMatch(/import (?!type)[^;]*@\/lib\/(prisma|audit|historial-de-inicios)/)
    })

    it('toda clave t("…") existe en es y en en', () => {
        const claves = [...fuente.matchAll(/\bt\(\s*"([\w.]+)"/g)].map((m) => m[1])
        expect(claves.length).toBeGreaterThan(15)
        for (const c of ['pagina', 'anterior', 'siguiente', 'paginacionAria', 'errorPagina']) expect(claves).toContain(c)
        for (const mensajes of [es, en] as Record<string, Record<string, unknown>>[]) {
            for (const c of claves) expect(mensajes.historial[c], `falta historial.${c}`).toBeTypeOf('string')
        }
    })

    it('al cambiar de página el foco vuelve a la cabecera; una petición vieja se aborta', () => {
        expect(fuente).toMatch(/moverFoco\.current = true/)
        expect(fuente).toMatch(/cabecera\.current\?\.focus\(\)/)
        expect(fuente).toContain('ctl.abort()')
        expect(fuente).toContain('signal: ctl.signal')
    })

    it('la fecha va en el idioma de quien mira', () => {
        expect(fuente).toContain('new Intl.DateTimeFormat(locale')
    })
})
