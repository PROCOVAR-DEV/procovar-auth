/**
 * Las piezas del centro de avisos pintadas a HTML con los textos reales: la fila se abre
 * con un <button> (teclado), con `break-words`, y el fallo del servicio se dice (no «sin avisos»).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import es from '../../../../../../messages/es.json'
import { ErrorDelCentro, FilaDeAviso, type FilaDeAvisoProps } from '../piezas-del-centro'
import type { AvisoVista } from '@/lib/notify/types'

const aviso = (extra: Partial<AvisoVista> = {}): AvisoVista => ({
    id: 'a1',
    notificationType: 'aviso',
    status: 'SENT',
    payload: { title: 'Titulo uno', body: 'Cuerpo uno' },
    createdAt: new Date().toISOString(),
    readAt: null,
    archivedAt: null,
    href: '/profile/reservations/R1',
    ...extra,
})

const base = { aviso: aviso(), ocupado: false, onOpen: vi.fn(), onGo: vi.fn(), onMarkRead: vi.fn(), onArchive: vi.fn(), onUnarchive: vi.fn() }
const pintar = (nodo: React.ReactElement) =>
    renderToStaticMarkup(
        <NextIntlClientProvider locale="es" messages={es} timeZone="UTC">
            {nodo}
        </NextIntlClientProvider>,
    )
const fila = (p: Partial<FilaDeAvisoProps> = {}) => pintar(<FilaDeAviso {...base} {...p} />)

describe('FilaDeAviso', () => {
    it('abrir el aviso es un <button type="button">, no un <div onClick>', () => {
        const html = fila()
        expect(html).toMatch(/<button type="button"[^>]*>Titulo uno<\/button>/)
        expect(html).not.toMatch(/<div[^>]*cursor-pointer/)
    })

    it('el botón del título cubre toda la fila (::after) y las acciones quedan por encima', () => {
        const html = fila()
        expect(html).toMatch(/<button[^>]*after:absolute[^>]*>Titulo uno/)
        expect(html).toContain('relative z-10')
    })

    it('el texto largo no desborda: break-words en título y cuerpo', () => {
        const html = fila()
        expect(html).toMatch(/<button[^>]*break-words[^>]*>Titulo uno/)
        expect(html).toMatch(/<p[^>]*line-clamp-2[^>]*break-words[^>]*>Cuerpo uno/)
    })

    it('todos los botones de icono tienen nombre accesible y son type="button"', () => {
        const botones = fila().match(/<button[^>]*>/g) ?? []
        expect(botones.length).toBeGreaterThanOrEqual(4)
        for (const b of botones) expect(b).toContain('type="button"')
        for (const b of botones.slice(1)) expect(b).toContain('aria-label=')
    })

    it('sin destino no hay botón de «Abrir» (ver detalle); archivado ofrece desarchivar', () => {
        expect(fila({ aviso: aviso({ href: null }) })).not.toContain('aria-label="Abrir"')
        expect(fila({ aviso: aviso({ archivedAt: '2026-10-02T00:00:00Z' }) })).toContain('aria-label="Restaurar"')
    })

    it('un payload con tipos raros no tumba la fila', () => {
        expect(() => fila({ aviso: aviso({ payload: { title: 42, body: { x: 1 } } as never }) })).not.toThrow()
    })
})

describe('ErrorDelCentro', () => {
    it('dice que no se pudieron cargar, con reintento, y no dice «sin avisos»', () => {
        const html = pintar(<ErrorDelCentro onRetry={vi.fn()} />)
        expect(html).toContain('role="alert"')
        expect(html).toContain('No se pudieron cargar los avisos')
        expect(html).toContain('Reintentar')
        expect(html).not.toContain('No tienes avisos')
    })
})
