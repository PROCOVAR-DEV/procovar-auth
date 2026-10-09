/**
 * Título y cuerpo de un aviso salen del `payload`, que escribe el emisor y nadie valida.
 * Un valor que no sea texto no puede lanzar: tumbaría la página entera (no hay error.tsx).
 */
import { describe, it, expect } from 'vitest'
import { notificationBody, notificationTitle } from '../format'
import type { InboxNotification } from '../types'

const aviso = (payload: unknown, tipo = 'pedido_rechazado'): InboxNotification =>
    ({
        id: 'a1',
        notificationType: tipo,
        status: 'SENT',
        recipientUserId: 'u1',
        payload,
        createdAt: '2026-10-01T10:00:00Z',
        readAt: null,
        archivedAt: null,
    }) as InboxNotification

describe('notificationTitle', () => {
    it('un texto se devuelve recortado', () => {
        expect(notificationTitle(aviso({ title: '  Pedido listo  ' }))).toBe('Pedido listo')
    })

    it('si no es texto, cae al tipo sin lanzar: número, objeto, lista, null, booleano', () => {
        for (const raro of [42, { a: 1 }, ['x'], null, true, undefined]) {
            expect(() => notificationTitle(aviso({ title: raro }))).not.toThrow()
            expect(notificationTitle(aviso({ title: raro }))).toBe('pedido rechazado')
        }
    })

    it('un título vacío o en blanco también cae al tipo', () => {
        expect(notificationTitle(aviso({ title: '   ' }))).toBe('pedido rechazado')
    })

    it('un payload ausente no lanza', () => {
        expect(notificationTitle(aviso(undefined))).toBe('pedido rechazado')
        expect(notificationTitle(aviso(null))).toBe('pedido rechazado')
    })

    it('el HTML llega tal cual (React lo escapa al pintar): ni se quita ni se interpreta', () => {
        expect(notificationTitle(aviso({ title: '<b>Hola</b> & <script>x</script>' }))).toBe(
            '<b>Hola</b> & <script>x</script>',
        )
    })

    it('un tipo que tampoco es texto no lanza', () => {
        expect(() => notificationTitle(aviso({}, undefined as unknown as string))).not.toThrow()
    })
})

describe('notificationBody', () => {
    it('un texto se devuelve recortado', () => {
        expect(notificationBody(aviso({ body: ' Detalle ' }))).toBe('Detalle')
    })

    it('si no es texto, es vacío y no lanza: número, objeto, lista, null', () => {
        for (const raro of [42, { a: 1 }, ['x'], null, false, undefined]) {
            expect(() => notificationBody(aviso({ body: raro }))).not.toThrow()
            expect(notificationBody(aviso({ body: raro }))).toBe('')
        }
    })

    it('un payload ausente no lanza', () => {
        expect(notificationBody(aviso(undefined))).toBe('')
    })

    it('el HTML llega tal cual', () => {
        expect(notificationBody(aviso({ body: '<img src=x onerror=alert(1)>' }))).toBe('<img src=x onerror=alert(1)>')
    })
})
