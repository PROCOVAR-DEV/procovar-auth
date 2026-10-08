/**
 * La paginación del panel de la campana: 5 por página, «página X de Y».
 *
 * Es lógica pura (sin red). Lo que se vigila: que la página 1 sea la primera, que los
 * límites no se pasen (ni página 0 ni más allá de la última), que el vacío no rompa y
 * que el contador de no leídos cuente TODA la lista y no solo lo que cabe en pantalla.
 */
import { describe, it, expect } from 'vitest'
import { PANEL_PAGE_SIZE, paginarAvisos, parsePagina } from '../panel'
import type { InboxNotification } from '../types'

const aviso = (n: number, extra: Partial<InboxNotification> = {}): InboxNotification => ({
    id: `a${n}`,
    notificationType: 'aviso',
    status: 'SENT',
    recipientUserId: 'u1',
    payload: { title: `Aviso ${n}` },
    createdAt: '2026-10-01T10:00:00Z',
    readAt: null,
    archivedAt: null,
    ...extra,
})
const lista = (cuantos: number) => Array.from({ length: cuantos }, (_, i) => aviso(i + 1))
const ids = (r: { notifications: InboxNotification[] }) => r.notifications.map((n) => n.id)

describe('parsePagina', () => {
    it('lo que no es un entero >= 1 es la primera página', () => {
        for (const malo of [null, '', 'abc', '0', '-3', '2.5', 'NaN']) expect(parsePagina(malo)).toBe(1)
    })
    it('un entero válido se respeta', () => {
        expect(parsePagina('1')).toBe(1)
        expect(parsePagina('3')).toBe(3)
    })
})

describe('paginarAvisos', () => {
    it('son 5 por página', () => {
        expect(PANEL_PAGE_SIZE).toBe(5)
    })

    it('12 avisos: página 1 de 3 con los 5 primeros', () => {
        const r = paginarAvisos(lista(12), 1)
        expect(ids(r)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
        expect(r).toMatchObject({ page: 1, pageCount: 3, total: 12 })
    })

    it('la siguiente y la última (con lo que sobra)', () => {
        expect(ids(paginarAvisos(lista(12), 2))).toEqual(['a6', 'a7', 'a8', 'a9', 'a10'])
        const ultima = paginarAvisos(lista(12), 3)
        expect(ids(ultima)).toEqual(['a11', 'a12'])
        expect(ultima.page).toBe(3)
    })

    it('el límite exacto: 5 son una página, 6 son dos', () => {
        expect(paginarAvisos(lista(5), 1).pageCount).toBe(1)
        expect(paginarAvisos(lista(6), 1).pageCount).toBe(2)
        expect(ids(paginarAvisos(lista(6), 2))).toEqual(['a6'])
    })

    it('pasarse de página recorta a la última, no devuelve una página vacía', () => {
        const r = paginarAvisos(lista(12), 99)
        expect(r.page).toBe(3)
        expect(ids(r)).toEqual(['a11', 'a12'])
    })

    it('la página 0 o negativa es la primera', () => {
        expect(paginarAvisos(lista(12), 0).page).toBe(1)
        expect(paginarAvisos(lista(12), -4).page).toBe(1)
    })

    it('vacío: página 1 de 1, sin avisos', () => {
        expect(paginarAvisos([], 1)).toEqual({ notifications: [], page: 1, pageCount: 1, total: 0, unreadCount: 0 })
        expect(paginarAvisos([], 7).page).toBe(1)
    })

    it('los archivados no cuentan ni salen', () => {
        const todos = [aviso(1), aviso(2, { archivedAt: '2026-10-02T00:00:00Z' }), aviso(3)]
        const r = paginarAvisos(todos, 1)
        expect(ids(r)).toEqual(['a1', 'a3'])
        expect(r.total).toBe(2)
    })

    it('el contador de no leídos es de TODA la lista, no de la página', () => {
        // 12 sin leer, y solo 5 en pantalla.
        expect(paginarAvisos(lista(12), 1).unreadCount).toBe(12)
        const leidos = lista(12).map((n, i) => (i < 4 ? { ...n, readAt: '2026-10-02T00:00:00Z', status: 'READ' } : n))
        expect(paginarAvisos(leidos, 3).unreadCount).toBe(8)
    })

    it('una «reserva en curso» ya vencida no se cuenta ni se enseña', () => {
        const vencida = aviso(1, {
            notificationType: 'reservation_hold_active',
            payload: { reservationId: 'r1', expiresAt: '2020-01-01T00:00:00Z' },
        })
        const r = paginarAvisos([vencida, aviso(2)], 1)
        expect(ids(r)).toEqual(['a2'])
        expect(r.total).toBe(1)
    })
})
