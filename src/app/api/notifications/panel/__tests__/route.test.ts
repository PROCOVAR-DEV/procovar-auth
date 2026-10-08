/**
 * GET /api/notifications/panel, visto desde fuera.
 *
 * Lo crítico: la consulta a Notify se hace con el id de la SESIÓN —nunca con uno que
 * venga en la petición—, una fila de otra persona no se cuela aunque Notify la devolviera,
 * y un servicio caído sale como error (502) y no como «No tienes avisos».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sesion = vi.hoisted(() => ({ resolveSessionUser: vi.fn() }))
const notify = vi.hoisted(() => ({ fetchInbox: vi.fn() }))

vi.mock('@/lib/require-admin', () => sesion)
vi.mock('@/lib/notify/inbox', () => notify)

import { GET } from '../route'
import type { InboxNotification } from '@/lib/notify/types'

const aviso = (n: number, destinatario = 'u-sesion'): InboxNotification => ({
    id: `a${n}`,
    notificationType: 'aviso',
    status: 'SENT',
    recipientUserId: destinatario,
    payload: { title: `Aviso ${n}` },
    createdAt: '2026-10-01T10:00:00Z',
    readAt: null,
    archivedAt: null,
})
const lista = (cuantos: number) => Array.from({ length: cuantos }, (_, i) => aviso(i + 1))
const bandeja = (data: InboxNotification[], failed = false) => ({ data, nextCursor: null, failed })

const llamar = async (qs = '') => {
    const res = await GET(new Request(`http://x/api/notifications/panel${qs}`) as never)
    return { status: res.status, body: await res.json() }
}

beforeEach(() => {
    vi.clearAllMocks()
    sesion.resolveSessionUser.mockResolvedValue({ user: { id: 'u-sesion' } })
    notify.fetchInbox.mockResolvedValue(bandeja([]))
})

describe('GET /api/notifications/panel', () => {
    it('sin sesión: 401 y no se llama a Notify', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null)
        const r = await llamar()
        expect(r.status).toBe(401)
        expect(notify.fetchInbox).not.toHaveBeenCalled()
    })

    it('la consulta usa el id de la sesión, aunque la petición traiga otro', async () => {
        await llamar('?userId=otra-persona&recipientUserId=otra-persona&page=1')
        expect(notify.fetchInbox).toHaveBeenCalledTimes(1)
        expect(notify.fetchInbox).toHaveBeenCalledWith({ userId: 'u-sesion', limit: 100 })
    })

    it('si Notify devolviera filas de otra persona, no salen', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja([aviso(1), aviso(2, 'otra-persona'), aviso(3)]))
        const r = await llamar()
        expect(r.status).toBe(200)
        expect(r.body.notifications.map((n: InboxNotification) => n.id)).toEqual(['a1', 'a3'])
        expect(r.body.total).toBe(2)
    })

    it('pagina de cinco en cinco: página 2 de 3', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja(lista(12)))
        const r = await llamar('?page=2')
        expect(r.body.notifications.map((n: InboxNotification) => n.id)).toEqual(['a6', 'a7', 'a8', 'a9', 'a10'])
        expect(r.body).toMatchObject({ page: 2, pageCount: 3, total: 12, unreadCount: 12 })
    })

    it('una página fuera de rango se recorta a la última', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja(lista(12)))
        const r = await llamar('?page=99')
        expect(r.body.page).toBe(3)
        expect(r.body.notifications).toHaveLength(2)
    })

    it('una página que no es un número es la primera', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja(lista(12)))
        expect((await llamar('?page=abc')).body.page).toBe(1)
    })

    it('sin avisos: 200 con la lista vacía (no es un error)', async () => {
        const r = await llamar()
        expect(r.status).toBe(200)
        expect(r.body).toMatchObject({ notifications: [], page: 1, pageCount: 1, total: 0, unreadCount: 0 })
    })

    it('Notify caído: 502, no una lista vacía', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja([], true))
        const r = await llamar()
        expect(r.status).toBe(502)
        expect(r.body).toEqual({ error: 'avisos_no_disponible' })
    })
})
