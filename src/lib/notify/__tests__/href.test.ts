/**
 * Adónde lleva un aviso: se deduce del payload y los ids se codifican, porque los pone el
 * emisor y no deben poder salirse de la ruta (`../`, `?`, `#`).
 */
import { describe, it, expect } from 'vitest'
import { notificationHref } from '../types'

describe('notificationHref', () => {
    it('reserva, factura y reserva de propietario', () => {
        expect(notificationHref({ kind: 'reservation', reservationId: '8842' })).toBe('/profile/reservations/8842')
        expect(notificationHref({ kind: 'invoice', invoiceId: 'F-1' })).toBe('/profile/invoices/F-1')
        expect(notificationHref({ role: 'owner', reservationId: '8842' })).toBe('/profile/org-reservations/8842')
    })

    it('los ids se codifican: no pueden escaparse de la ruta', () => {
        expect(notificationHref({ kind: 'reservation', reservationId: '../x?y=1#z' })).toBe(
            '/profile/reservations/..%2Fx%3Fy%3D1%23z',
        )
        expect(notificationHref({ kind: 'invoice', invoiceId: 'a/b' })).toBe('/profile/invoices/a%2Fb')
        expect(notificationHref({ role: 'owner', reservationId: 'a b' })).toBe('/profile/org-reservations/a%20b')
    })

    it('sin id o sin tipo conocido, no hay destino', () => {
        expect(notificationHref({ kind: 'reservation' })).toBeNull()
        expect(notificationHref({})).toBeNull()
    })
})
