/**
 * El panel de la campana en cada uno de sus estados: cargando, error, vacío y con
 * avisos paginados. Se pinta a HTML (no hay navegador en estas pruebas) con los textos
 * REALES de `messages/es.json`, así que si falta una clave o cambia el texto, falla.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import es from '../../../../../messages/es.json'
import { PanelDeAvisos, type PanelDeAvisosProps } from '../panel-de-avisos'
import type { InboxNotification } from '@/lib/notify/types'

const aviso = (n: number, extra: Partial<InboxNotification> = {}): InboxNotification => ({
    id: `a${n}`,
    notificationType: 'aviso',
    status: 'SENT',
    recipientUserId: 'u1',
    payload: { title: `Titulo ${n}`, body: `Cuerpo ${n}` },
    createdAt: new Date().toISOString(),
    readAt: null,
    archivedAt: null,
    ...extra,
})

const base: PanelDeAvisosProps = {
    avisos: [],
    cargando: false,
    error: false,
    page: 1,
    pageCount: 1,
    sinLeer: 0,
    onPage: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onGestionar: vi.fn(),
}

const pintar = (props: Partial<PanelDeAvisosProps>) =>
    renderToStaticMarkup(
        <NextIntlClientProvider locale="es" messages={es} timeZone="UTC">
            <PanelDeAvisos {...base} {...props} />
        </NextIntlClientProvider>,
    )

/** La etiqueta <button> que lleva ese aria-label. */
const boton = (html: string, etiqueta: string) =>
    html.match(new RegExp(`<button[^>]*aria-label="${etiqueta}"[^>]*>`))?.[0] ?? ''

/** Apagado = `aria-disabled="true"`: el botón sigue enfocable (no usa `disabled`). */
const apagado = (etiqueta: string) => /\saria-disabled="true"/.test(etiqueta)
/** El atributo `disabled` de verdad (las clases `disabled:…` de Tailwind no cuentan). */
const conDisabled = (etiqueta: string) => /\sdisabled(=""|\s|>)/.test(etiqueta)

const cinco = [1, 2, 3, 4, 5].map((n) => aviso(n))

describe('PanelDeAvisos', () => {
    it('siempre lleva el botón «Gestionar avisos» hacia el centro de avisos', () => {
        for (const props of [{}, { cargando: true }, { error: true }, { avisos: cinco }]) {
            const html = pintar(props)
            expect(html).toContain('href="/profile/notifications"')
            expect(html).toContain('Gestionar avisos')
        }
    })

    it('cargando: lo dice y no enseña ni el vacío ni la paginación', () => {
        const html = pintar({ cargando: true, pageCount: 3 })
        expect(html).toContain('Cargando avisos')
        expect(html).not.toContain('No tienes avisos')
        expect(html).toContain('aria-busy="true"')
    })

    it('vacío: «No tienes avisos»', () => {
        const html = pintar({})
        expect(html).toContain('No tienes avisos')
        expect(html).not.toContain('Página')
        expect(html).not.toContain('<li')
    })

    it('error del servicio: avisa dentro del panel, con reintento, sin lista ni paginación', () => {
        const html = pintar({ error: true, avisos: cinco, pageCount: 3 })
        expect(html).toContain('role="alert"')
        expect(html).toContain('No se pudieron cargar los avisos')
        expect(html).toContain('Reintentar')
        expect(html).not.toContain('No tienes avisos')
        expect(html).not.toContain('<li')
        expect(html).not.toContain('Página 1 de 3')
    })

    it('con avisos: cinco filas, «Página 1 de 3», anterior apagado y siguiente activo', () => {
        const html = pintar({ avisos: cinco, page: 1, pageCount: 3 })
        expect(html.match(/<li/g)).toHaveLength(5)
        expect(html).toContain('Página 1 de 3')
        expect(apagado(boton(html, 'Página anterior'))).toBe(true)
        expect(apagado(boton(html, 'Página siguiente'))).toBe(false)
    })

    it('en la última página, siguiente apagado y anterior activo', () => {
        const html = pintar({ avisos: cinco.slice(0, 2), page: 3, pageCount: 3 })
        expect(html).toContain('Página 3 de 3')
        expect(apagado(boton(html, 'Página siguiente'))).toBe(true)
        expect(apagado(boton(html, 'Página anterior'))).toBe(false)
    })

    it('los botones de página nunca llevan `disabled`: ni en los bordes ni cargando (no pierden el foco)', () => {
        for (const props of [
            { avisos: cinco, page: 1, pageCount: 3 },
            { avisos: cinco, page: 3, pageCount: 3 },
            { avisos: cinco, page: 2, pageCount: 3, cargando: true },
        ]) {
            const html = pintar(props)
            expect(conDisabled(boton(html, 'Página anterior'))).toBe(false)
            expect(conDisabled(boton(html, 'Página siguiente'))).toBe(false)
        }
    })

    it('cargando no apaga los botones por sí solo (solo los bordes)', () => {
        const html = pintar({ avisos: cinco, page: 2, pageCount: 3, cargando: true })
        expect(apagado(boton(html, 'Página anterior'))).toBe(false)
        expect(apagado(boton(html, 'Página siguiente'))).toBe(false)
    })

    it('aria-live solo en «Página X de Y», no en toda la lista', () => {
        const html = pintar({ avisos: cinco, page: 1, pageCount: 3 })
        expect(html.match(/aria-live=/g)).toHaveLength(1)
        expect(html).toMatch(/aria-live="polite"[^>]*>Página 1 de 3/)
    })

    it('«sin leer» es isUnread: estado SENT y sin readAt', () => {
        // Leído por estado aunque falte readAt, y leído por readAt aunque el estado sea SENT.
        const leidoPorEstado = aviso(1, { status: 'READ', readAt: null })
        const leidoPorFecha = aviso(2, { status: 'SENT', readAt: new Date().toISOString() })
        const sinLeer = aviso(3)
        expect(pintar({ avisos: [leidoPorEstado] }).match(/Sin leer/g)).toBeNull()
        expect(pintar({ avisos: [leidoPorFecha] }).match(/Sin leer/g)).toBeNull()
        expect(pintar({ avisos: [sinLeer] }).match(/Sin leer/g)).toHaveLength(1)
    })

    it('un título que no es texto no tumba el panel', () => {
        const raro = aviso(9, { payload: { title: 42, body: { x: 1 } } as never })
        expect(() => pintar({ avisos: [raro] })).not.toThrow()
    })

    it('con una sola página no hay paginación', () => {
        const html = pintar({ avisos: cinco, page: 1, pageCount: 1 })
        expect(html).not.toContain('Página 1 de 1')
        expect(html).not.toContain('Página siguiente')
    })

    it('el aviso sin leer se distingue también para el lector de pantalla', () => {
        const html = pintar({ avisos: [aviso(1), aviso(2, { readAt: new Date().toISOString() })], sinLeer: 1 })
        expect(html.match(/Sin leer/g)).toHaveLength(1)
        expect(html).toContain('1 sin leer')
    })

    it('enseña el título y el cuerpo del aviso', () => {
        const html = pintar({ avisos: [aviso(7)] })
        expect(html).toContain('Titulo 7')
        expect(html).toContain('Cuerpo 7')
    })

    it('el <h2> lleva el id que el diálogo usa en aria-labelledby', () => {
        expect(pintar({ tituloId: 'campana-titulo' })).toMatch(/<h2 id="campana-titulo"[^>]*>Avisos<\/h2>/)
    })

    it('«100+»: el texto de sin leer manda sobre el número', () => {
        const html = pintar({ avisos: [aviso(1)], sinLeer: 100, sinLeerTexto: '100+' })
        expect(html).toContain('100+ sin leer')
    })

    it('el cuerpo con line-clamp no desborda: break-words', () => {
        expect(pintar({ avisos: [aviso(1)] })).toMatch(/line-clamp-2[^"]*break-words/)
    })
})
