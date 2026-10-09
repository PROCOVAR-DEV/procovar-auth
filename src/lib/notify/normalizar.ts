/**
 * De la fila de Notify a lo que sale hacia el navegador. Puro y sin red.
 *
 * El payload lo escribe el emisor (qb-back) y nadie lo valida: puede llegar `null`, una
 * lista, un número, o con `code` como objeto. Se arregla AQUÍ, en el servidor, una sola
 * vez, y la interfaz recibe formas conocidas. Dos pasos:
 *
 *  1. `normalizarFila`: forma segura, pero con todo lo que el servidor necesita para
 *     decidir (ids de reserva y caducidad de las reservas en curso, `dropStaleHolds`).
 *  2. `vistaDeAviso`: lo que viaja al navegador, recortado a lo que se pinta, con el
 *     destino (`href`) ya calculado. El `resumeToken` firmado solo existe dentro de ese
 *     `href`; no va suelto, ni `recipientUserId`, ni los ids de reserva.
 */
import {
    esObjetoPlano,
    notificationHref,
    type AvisoVista,
    type InboxNotification,
    type NotificationPayload,
} from "./types";

const cadena = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numero = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const uno = <T extends string>(v: unknown, validos: readonly T[]): T | undefined =>
    validos.includes(v as T) ? (v as T) : undefined;

export function normalizarPayload(crudo: unknown): NotificationPayload {
    if (!esObjetoPlano(crudo)) return {};
    const ids = Array.isArray(crudo.reservationIds) ? crudo.reservationIds.filter((x) => typeof x === "string") : undefined;
    return {
        role: uno(crudo.role, ["client", "owner"] as const),
        kind: uno(crudo.kind, ["reservation", "invoice"] as const),
        reservationId: cadena(crudo.reservationId),
        invoiceId: cadena(crudo.invoiceId),
        propertyId: cadena(crudo.propertyId),
        propertyName: cadena(crudo.propertyName),
        code: cadena(crudo.code),
        title: cadena(crudo.title),
        body: cadena(crudo.body),
        checkIn: cadena(crudo.checkIn),
        checkOut: cadena(crudo.checkOut),
        expiresAt: cadena(crudo.expiresAt),
        resumeToken: cadena(crudo.resumeToken),
        reservationIds: ids,
        roomsCount: numero(crudo.roomsCount),
    };
}

/** Fila de Notify con forma segura, o `null` si ni siquiera tiene `id`. */
export function normalizarFila(crudo: unknown): InboxNotification | null {
    if (!esObjetoPlano(crudo) || typeof crudo.id !== "string" || !crudo.id) return null;
    const fecha = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
        id: crudo.id,
        notificationType: cadena(crudo.notificationType) ?? "",
        status: cadena(crudo.status) ?? "",
        recipientUserId: cadena(crudo.recipientUserId) ?? "",
        payload: normalizarPayload(crudo.payload),
        createdAt: cadena(crudo.createdAt) ?? "",
        readAt: fecha(crudo.readAt),
        archivedAt: fecha(crudo.archivedAt),
    };
}

/** Normaliza una lista de filas, descartando las que no son filas. */
export const normalizarFilas = (crudas: unknown[]): InboxNotification[] =>
    crudas.flatMap((c) => normalizarFila(c) ?? []);

/** Lo que se pinta de un aviso, y su destino ya calculado. Recibe una fila ya normalizada. */
export function vistaDeAviso(n: InboxNotification): AvisoVista {
    const { title, body, propertyName, code, checkIn, checkOut, role, kind } = n.payload;
    return {
        id: n.id,
        notificationType: n.notificationType,
        status: n.status,
        createdAt: n.createdAt,
        readAt: n.readAt,
        archivedAt: n.archivedAt,
        payload: { title, body, propertyName, code, checkIn, checkOut, role, kind },
        href: notificationHref(n.payload),
    };
}
