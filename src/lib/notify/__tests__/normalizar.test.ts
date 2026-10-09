/**
 * El payload lo escribe otro servicio y nadie lo valida. Lo que sale hacia el navegador
 * pasa por aquí: forma segura, recortado a lo que se pinta, sin lanzar con nada raro.
 */
import { describe, it, expect } from 'vitest'
import { normalizarFila, normalizarPayload, vistaDeAviso } from '../normalizar'
import { notificationHref, dropStaleHolds, type InboxNotification } from '../types'
import { notificationColor, notificationTitle, notificationBody } from '../format'

const RAROS: unknown[] = [null, undefined, [], [1, 'a'], 0, 42, 'texto', true, () => 1]

const fila = (payload: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'a1',
    notificationType: 'reservation_hold_active',
    status: 'SENT',
    recipientUserId: 'u1',
    payload,
    createdAt: '2026-10-01T10:00:00Z',
    readAt: null,
    archivedAt: null,
    ...extra,
})

describe('normalizarPayload', () => {
    it.each(RAROS.map((r) => [r]))('payload %s: queda {}', (raro) => {
        expect(normalizarPayload(raro)).toEqual({})
    })

    it('code, propertyName, checkIn y checkOut solo si son texto', () => {
        const p = normalizarPayload({ code: { a: 1 }, propertyName: 5, checkIn: [], checkOut: null })
        expect(p.code).toBeUndefined()
        expect(p.propertyName).toBeUndefined()
        expect(p.checkIn).toBeUndefined()
        expect(p.checkOut).toBeUndefined()
        const ok = normalizarPayload({ code: 'AB12', propertyName: 'Casa', checkIn: '2026-10-10', checkOut: '2026-10-12' })
        expect(ok).toMatchObject({ code: 'AB12', propertyName: 'Casa', checkIn: '2026-10-10', checkOut: '2026-10-12' })
    })

    it('role y kind solo con los valores conocidos; reservationIds solo textos', () => {
        const p = normalizarPayload({ role: 'admin', kind: 7, reservationIds: ['R1', 2, null, 'R3'] })
        expect(p.role).toBeUndefined()
        expect(p.kind).toBeUndefined()
        expect(p.reservationIds).toEqual(['R1', 'R3'])
        expect(normalizarPayload({ reservationIds: 5 }).reservationIds).toBeUndefined()
    })
})

describe('normalizarFila', () => {
    it('sin id de texto no es una fila', () => {
        for (const x of [null, 5, 'x', [], {}, { id: 3 }, { id: '' }]) expect(normalizarFila(x)).toBeNull()
    })
    it('arregla los tipos de la fila y deja readAt/archivedAt en texto o null', () => {
        const n = normalizarFila(fila({ title: 'T' }, { status: 9, readAt: 0, archivedAt: {}, createdAt: null }))!
        expect(n.status).toBe('')
        expect(n.readAt).toBeNull()
        expect(n.archivedAt).toBeNull()
        expect(n.createdAt).toBe('')
    })
})

describe('con un payload raro nada lanza (href, color, título, cuerpo, holds)', () => {
    it.each(RAROS.map((r) => [r]))('payload %s', (raro) => {
        expect(() => notificationHref(raro)).not.toThrow()
        expect(notificationHref(raro)).toBeNull()
        expect(notificationColor(raro)).toBe('default')
        const n = { notificationType: 'x_y', payload: raro } as never
        expect(() => notificationTitle(n)).not.toThrow()
        expect(() => notificationBody(n)).not.toThrow()
        const f = { ...(fila(raro) as object) } as InboxNotification
        expect(() => dropStaleHolds([f])).not.toThrow()
    })

    it('ids que no son texto no fabrican una ruta', () => {
        expect(notificationHref({ kind: 'reservation', reservationId: { a: 1 } })).toBeNull()
        expect(notificationHref({ kind: 'invoice', invoiceId: 5 })).toBeNull()
        expect(notificationHref({ role: 'owner', reservationId: ['R1'] })).toBeNull()
        expect(notificationHref({ resumeToken: 9, kind: 'reservation', reservationId: 'R1' })).toBe('/profile/reservations/R1')
    })

    it('reservationIds que no es lista no tumba dropStaleHolds (antes: spread de un número)', () => {
        const f = normalizarFila(fila({ reservationId: 'R1', reservationIds: 5 }))!
        expect(() => dropStaleHolds([f])).not.toThrow()
    })
})

describe('vistaDeAviso: lo que viaja al navegador', () => {
    const base = normalizarFila(
        fila({
            title: 'Reserva en curso',
            body: 'Termina tu reserva',
            propertyName: 'Casa',
            code: 'AB12',
            kind: 'reservation',
            reservationId: 'R1',
            reservationIds: ['R1', 'R2'],
            resumeToken: 'jwt.secreto.firmado',
            expiresAt: '2030-01-01T00:00:00Z',
            roomsCount: 2,
            propertyId: 'P1',
            invoiceId: 'F1',
        }),
    )!

    it('lleva lo que se pinta y el destino ya calculado', () => {
        const v = vistaDeAviso(base)
        expect(v.payload).toMatchObject({ title: 'Reserva en curso', body: 'Termina tu reserva', propertyName: 'Casa', code: 'AB12', kind: 'reservation' })
        expect(v.href).toBe('/booking?secure=jwt.secreto.firmado')
    })

    it('no lleva destinatario, ni ids, ni caducidad, ni el token suelto', () => {
        const v = vistaDeAviso(base)
        expect(Object.keys(v).sort()).toEqual(['archivedAt', 'createdAt', 'href', 'id', 'notificationType', 'payload', 'readAt', 'status'])
        const payload = JSON.stringify(v.payload)
        for (const k of ['resumeToken', 'jwt.secreto', 'reservationId', 'reservationIds', 'expiresAt', 'roomsCount', 'propertyId', 'invoiceId']) {
            expect(payload).not.toContain(k)
        }
        expect(JSON.stringify(v)).not.toContain('u1')
    })

    it('sin destino: href null', () => {
        expect(vistaDeAviso(normalizarFila(fila(null))!).href).toBeNull()
    })
})
