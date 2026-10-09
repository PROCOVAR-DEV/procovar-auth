/**
 * Las rutas de /api/notifications vistas desde fuera, con la sesión y Notify simulados.
 *
 * Lo crítico: la clave HMAC de Notify es de la APLICACIÓN, no de la persona; lo único que
 * separa una bandeja de otra es el guard de propiedad de `_ownership.ts`. Cada ruta con id
 * (`[id]`, `[id]/read`, `[id]/archive`, `[id]/unarchive`) tiene que dar 401 sin sesión, NO
 * tocar un aviso ajeno (ni llamar a la acción de Notify) y actuar sobre uno propio.
 *
 * Decisión: un aviso ajeno contesta 404, IGUAL que uno que no existe (antes 403). Con 403
 * quien prueba ids sabría cuáles existen y son de otra persona. «Notify no contesta» es 502,
 * no 404. Si alguien cambia el 404 por 403, la prueba «ajeno = inexistente» se pone roja.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sesion = vi.hoisted(() => ({ resolveSessionUser: vi.fn() }))
const notify = vi.hoisted(() => ({
    fetchNotification: vi.fn(),
    fetchInbox: vi.fn(),
    markRead: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    archiveAllRead: vi.fn(),
}))

vi.mock('@/lib/require-admin', () => sesion)
vi.mock('@/lib/notify/inbox', () => notify)

import { GET as getLista } from '../route'
import { GET as getUno } from '../[id]/route'
import { POST as postRead } from '../[id]/read/route'
import { POST as postArchive } from '../[id]/archive/route'
import { POST as postUnarchive } from '../[id]/unarchive/route'
import { POST as postArchiveRead } from '../archive-read/route'
import type { InboxNotification } from '@/lib/notify/types'

const YO = 'u-sesion'
const OTRO = 'u-otro'

const fila = (id: string, dueno = YO, extra: Partial<InboxNotification> = {}): InboxNotification => ({
    id,
    notificationType: 'aviso',
    status: 'SENT',
    recipientUserId: dueno,
    payload: { title: `Aviso ${id}`, body: 'cuerpo' },
    createdAt: '2026-10-01T10:00:00Z',
    readAt: null,
    archivedAt: null,
    ...extra,
})
const hallado = (n: InboxNotification) => ({ kind: 'found', notification: n })
const bandeja = (data: unknown[], failed = false) => ({ data, nextCursor: null, failed })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const esPrivada = (h: Headers) => {
    expect(h.get('cache-control')).toBe('private, no-store')
    expect(h.get('vary')).toBe('Cookie')
}

beforeEach(() => {
    vi.clearAllMocks()
    sesion.resolveSessionUser.mockResolvedValue({ user: { id: YO } })
    notify.fetchNotification.mockResolvedValue(hallado(fila('a1')))
    notify.fetchInbox.mockResolvedValue(bandeja([]))
    for (const f of [notify.markRead, notify.archive, notify.unarchive, notify.archiveAllRead]) f.mockResolvedValue(true)
})

const accionesPorId = [
    { nombre: 'read', post: postRead, accion: notify.markRead },
    { nombre: 'archive', post: postArchive, accion: notify.archive },
    { nombre: 'unarchive', post: postUnarchive, accion: notify.unarchive },
]

describe.each(accionesPorId)('POST /api/notifications/[id]/$nombre', ({ post, accion }) => {
    const llamar = (id = 'a1') => post(new Request('http://x/') as never, params(id))

    it('sin sesión: 401, y ni se mira el aviso ni se llama a la acción', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null)
        const res = await llamar()
        expect(res.status).toBe(401)
        expect(notify.fetchNotification).not.toHaveBeenCalled()
        expect(accion).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('aviso AJENO: 404 y la acción de Notify NO se llama', async () => {
        notify.fetchNotification.mockResolvedValue(hallado(fila('a1', OTRO)))
        const res = await llamar()
        expect(res.status).toBe(404)
        expect(accion).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('ajeno = inexistente: mismo estado y mismo cuerpo (no revela que el id existe)', async () => {
        notify.fetchNotification.mockResolvedValue(hallado(fila('a1', OTRO)))
        const ajeno = await llamar()
        notify.fetchNotification.mockResolvedValue({ kind: 'not_found' })
        const inexistente = await llamar()
        expect(ajeno.status).toBe(inexistente.status)
        expect(await ajeno.json()).toEqual(await inexistente.json())
        expect(accion).not.toHaveBeenCalled()
    })

    it('un aviso sin destinatario tampoco es de nadie: 404', async () => {
        notify.fetchNotification.mockResolvedValue(hallado(fila('a1', undefined as never, { recipientUserId: undefined as never })))
        expect((await llamar()).status).toBe(404)
        expect(accion).not.toHaveBeenCalled()
    })

    it('Notify no contesta al comprobar el dueño: 502 (no 404) y no se actúa', async () => {
        notify.fetchNotification.mockResolvedValue({ kind: 'failed' })
        const res = await llamar()
        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({ error: 'avisos_no_disponible' })
        expect(accion).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('aviso PROPIO: 200, la acción se llama una vez con ese id', async () => {
        const res = await llamar('a1')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(accion).toHaveBeenCalledTimes(1)
        expect(accion).toHaveBeenCalledWith('a1')
        esPrivada(res.headers)
    })

    it('la acción de Notify falla tras comprobar el dueño: 502', async () => {
        accion.mockResolvedValue(false)
        const res = await llamar()
        expect(res.status).toBe(502)
        esPrivada(res.headers)
    })
})

describe('GET /api/notifications/[id]', () => {
    const llamar = (id = 'a1') => getUno(new Request('http://x/') as never, params(id))

    it('sin sesión: 401 con cabeceras privadas', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null)
        const res = await llamar()
        expect(res.status).toBe(401)
        expect(notify.fetchNotification).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('aviso ajeno: 404 y el cuerpo no contiene nada del aviso', async () => {
        notify.fetchNotification.mockResolvedValue(hallado(fila('a1', OTRO, { payload: { title: 'SECRETO-AJENO' } })))
        const res = await llamar()
        expect(res.status).toBe(404)
        expect(JSON.stringify(await res.json())).not.toContain('SECRETO-AJENO')
        esPrivada(res.headers)
    })

    it('Notify caído: 502', async () => {
        notify.fetchNotification.mockResolvedValue({ kind: 'failed' })
        const res = await llamar()
        expect(res.status).toBe(502)
        esPrivada(res.headers)
    })

    it('aviso propio: 200 con lo que se pinta, el destino calculado y NADA más', async () => {
        notify.fetchNotification.mockResolvedValue(
            hallado(
                fila('a1', YO, {
                    payload: {
                        title: 'Reserva en curso',
                        kind: 'reservation',
                        reservationId: 'R1',
                        reservationIds: ['R1', 'R2'],
                        resumeToken: 'jwt.firmado.aqui',
                        extraDesconocido: 'x',
                    },
                }),
            ),
        )
        const res = await llamar()
        expect(res.status).toBe(200)
        esPrivada(res.headers)
        const { notification } = await res.json()
        expect(notification.href).toBe('/booking?secure=jwt.firmado.aqui')
        expect(notification.payload.title).toBe('Reserva en curso')
        expect(notification).not.toHaveProperty('recipientUserId')
        // El token viaja solo dentro del href; no suelto en el payload.
        const payload = JSON.stringify(notification.payload)
        for (const prohibido of ['resumeToken', 'jwt.firmado', 'reservationIds', 'reservationId', 'extraDesconocido']) {
            expect(payload).not.toContain(prohibido)
        }
    })

    it.each([null, [], 7, 'texto'])('payload %j: 200 y sin lanzar', async (raro) => {
        notify.fetchNotification.mockResolvedValue(hallado(fila('a1', YO, { payload: raro as never })))
        const res = await llamar()
        expect(res.status).toBe(200)
        expect((await res.json()).notification.href).toBeNull()
    })
})

describe('POST /api/notifications/archive-read', () => {
    it('sin sesión: 401 y no se archiva nada', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null)
        const res = await postArchiveRead()
        expect(res.status).toBe(401)
        expect(notify.archiveAllRead).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('archiva los leídos de la persona de la SESIÓN', async () => {
        const res = await postArchiveRead()
        expect(res.status).toBe(200)
        expect(notify.archiveAllRead).toHaveBeenCalledWith(YO)
        esPrivada(res.headers)
    })

    it('Notify falla: 502', async () => {
        notify.archiveAllRead.mockResolvedValue(false)
        const res = await postArchiveRead()
        expect(res.status).toBe(502)
        esPrivada(res.headers)
    })
})

describe('GET /api/notifications (lista)', () => {
    const llamar = async (qs = '') => {
        const res = await getLista(new Request(`http://x/api/notifications${qs}`) as never)
        return { res, status: res.status, body: await res.json() }
    }

    it('sin sesión: 401, sin llamar a Notify, con cabeceras privadas', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null)
        const { res, status } = await llamar()
        expect(status).toBe(401)
        expect(notify.fetchInbox).not.toHaveBeenCalled()
        esPrivada(res.headers)
    })

    it('las dos consultas usan el id de la sesión, aunque la petición traiga otro', async () => {
        await llamar(`?userId=${OTRO}&recipientUserId=${OTRO}`)
        expect(notify.fetchInbox).toHaveBeenCalledTimes(2)
        for (const [args] of notify.fetchInbox.mock.calls) expect(args.userId).toBe(YO)
    })

    it('filas de otra persona (aunque Notify las devolviera) no salen, ni cuentan', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja([fila('a1'), fila('a2', OTRO), fila('a3')]))
        const { status, body } = await llamar()
        expect(status).toBe(200)
        expect(body.notifications.map((n: { id: string }) => n.id)).toEqual(['a1', 'a3'])
        expect(body.unreadCount).toBe(2)
    })

    it('Notify caído (la página): 502, no 200 con la lista vacía', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja([], true))
        const { res, status, body } = await llamar()
        expect(status).toBe(502)
        expect(body).toEqual({ error: 'avisos_no_disponible' })
        esPrivada(res.headers)
    })

    it('Notify caído solo en la consulta de contexto: 502 también (el contador sería mentira)', async () => {
        notify.fetchInbox.mockResolvedValueOnce(bandeja([fila('a1')])).mockResolvedValueOnce(bandeja([], true))
        expect((await llamar()).status).toBe(502)
    })

    it('sin avisos de verdad: 200 con la lista vacía (no es un error)', async () => {
        const { res, status, body } = await llamar()
        expect(status).toBe(200)
        expect(body).toMatchObject({ notifications: [], unreadCount: 0 })
        esPrivada(res.headers)
    })

    it('la pestaña de archivados solo enseña archivados; las otras, ninguno', async () => {
        const archivado = fila('a2', YO, { archivedAt: '2026-10-02T00:00:00Z' })
        notify.fetchInbox.mockResolvedValue(bandeja([fila('a1'), archivado]))
        expect((await llamar('?filter=archived')).body.notifications.map((n: { id: string }) => n.id)).toEqual(['a2'])
        expect((await llamar('?filter=all')).body.notifications.map((n: { id: string }) => n.id)).toEqual(['a1'])
    })

    it.each([null, [], 7, 'texto', { code: { x: 1 }, propertyName: 5, checkIn: [], checkOut: 3, reservationIds: 5 }])(
        'payload %j: 200, los campos que no son texto no llegan, y no se lanza',
        async (raro) => {
            notify.fetchInbox.mockResolvedValue(bandeja([fila('a1', YO, { payload: raro as never })]))
            const { status, body } = await llamar()
            expect(status).toBe(200)
            const [n] = body.notifications
            for (const campo of ['code', 'propertyName', 'checkIn', 'checkOut'] as const) {
                expect(n.payload[campo] === undefined || typeof n.payload[campo] === 'string').toBe(true)
            }
            expect(n).not.toHaveProperty('recipientUserId')
        },
    )

    it('un campo de texto bueno SÍ llega', async () => {
        notify.fetchInbox.mockResolvedValue(
            bandeja([fila('a1', YO, { payload: { code: 'AB12', propertyName: 'Casa', checkIn: '2026-10-10', checkOut: '2026-10-12' } })]),
        )
        const { body } = await llamar()
        expect(body.notifications[0].payload).toMatchObject({ code: 'AB12', propertyName: 'Casa', checkIn: '2026-10-10', checkOut: '2026-10-12' })
    })

    it('una fila que ni es objeto (null, número) se descarta sin tumbar la lista', async () => {
        notify.fetchInbox.mockResolvedValue(bandeja([null, 5, fila('a1')]))
        const { status, body } = await llamar()
        expect(status).toBe(200)
        expect(body.notifications.map((n: { id: string }) => n.id)).toEqual(['a1'])
    })
})
