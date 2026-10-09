/**
 * La campana cerrada, con sesión y avisos simulados: la región viva «N sin leer» para el
 * lector de pantalla, y el contador que no infravalora cuando la lista llega al tope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import es from '../../../../../messages/es.json'

const estado = vi.hoisted(() => ({
    sesion: { data: { user: { id: 'u1' } } } as { data: unknown },
    hook: {} as Record<string, unknown>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => estado.sesion } }))
vi.mock('@/hooks/use-notifications', () => ({ useNotifications: () => estado.hook }))

import { NotificationBell } from '../notification-bell'

const hook = (extra: Record<string, unknown>) => ({
    notifications: [],
    unreadCount: 0,
    loading: false,
    error: false,
    pageInfo: { page: 1, pageCount: 1, total: 0 },
    markRead: vi.fn(),
    refresh: vi.fn(),
    ...extra,
})
const pintar = () =>
    renderToStaticMarkup(
        <NextIntlClientProvider locale="es" messages={es} timeZone="UTC">
            <NotificationBell />
        </NextIntlClientProvider>,
    )
const estadoSr = (html: string) => html.match(/<span role="status" class="sr-only">([^<]*)<\/span>/)?.[1]

beforeEach(() => {
    estado.sesion = { data: { user: { id: 'u1' } } }
})

describe('campana: región viva para el lector de pantalla', () => {
    it('existe siempre (para que el cambio se anuncie) y está vacía mientras carga', () => {
        estado.hook = hook({ unreadCount: 3, loading: true })
        expect(estadoSr(pintar())).toBe('')
    })

    it('al cargar anuncia «Avisos: N sin leer»', () => {
        estado.hook = hook({ unreadCount: 3, pageInfo: { page: 1, pageCount: 1, total: 12 } })
        expect(estadoSr(pintar())).toBe('Avisos: 3 sin leer')
    })

    it('sin nada sin leer, o con error del servicio, no anuncia números', () => {
        estado.hook = hook({ unreadCount: 0 })
        expect(estadoSr(pintar())).toBe('')
        estado.hook = hook({ unreadCount: 3, error: true })
        expect(estadoSr(pintar())).toBe('')
    })

    it('sin sesión no hay campana', () => {
        estado.sesion = { data: null }
        estado.hook = hook({})
        expect(pintar()).toBe('')
    })
})

describe('campana: el número no infravalora', () => {
    it('lista al tope y todo sin leer: «100+» en el aria-label y en la región viva', () => {
        estado.hook = hook({ unreadCount: 100, pageInfo: { page: 1, pageCount: 20, total: 100 } })
        const html = pintar()
        expect(html).toContain('aria-label="Avisos, 100+ sin leer"')
        expect(estadoSr(html)).toBe('Avisos: 100+ sin leer')
    })

    it('lista al tope con pocos sin leer: «3+» (cota), no «3» exacto', () => {
        estado.hook = hook({ unreadCount: 3, pageInfo: { page: 1, pageCount: 20, total: 100 } })
        const html = pintar()
        expect(html).toContain('aria-label="Avisos, 3+ sin leer"')
        expect(html).toContain('>3+</span>')
    })

    it('lista corta: el número exacto', () => {
        estado.hook = hook({ unreadCount: 3, pageInfo: { page: 1, pageCount: 1, total: 8 } })
        expect(pintar()).toContain('aria-label="Avisos, 3 sin leer"')
    })
})
