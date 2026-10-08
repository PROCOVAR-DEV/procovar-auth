/**
 * Shared (client-safe) shapes for the QB Notify v2 inbox.
 *
 * NOTHING in this module may touch QB_NOTIFY_SECRET / QB_NOTIFY_KEY_ID — it is imported by
 * client components (the bell, the notification centre). The HMAC client lives
 * in `./inbox.ts`, which is server-only.
 */

/** Lifecycle of a notification in QB Notify. `SENT` = delivered but unread. */
export type NotifyStatus = "PENDING" | "QUEUED" | "SENT" | "READ" | "FAILED" | "CANCELLED";

/** The types qb-back emits on the IN_APP channel. */
export type NotifyType =
    | "reservation_hold_active"
    | "reservation_confirmed"
    | "reservation_cancelled"
    | "reservation_refund"
    | "invoice_issued"
    | "owner_reservation_created";

/**
 * Payload contract agreed with qb-back. The API returns NO rendered title/body:
 * everything displayable lives here, already localized by the emitter.
 */
export interface NotificationPayload {
    role?: "client" | "owner";
    kind?: "reservation" | "invoice";
    reservationId?: string;
    invoiceId?: string;
    propertyId?: string;
    propertyName?: string;
    code?: string;
    title?: string;
    body?: string;
    checkIn?: string;
    checkOut?: string;
    /** Only on holds: after this instant the hold no longer exists. */
    expiresAt?: string;
    /**
     * Only on holds. The booking flow does NOT accept its steps in the clear: it
     * expects them signed in `/booking?secure=<jwt>` (see booking/_utils.ts). This is
     * that token, re-issued by qb-back from the held reservation — the only way to
     * send the user back to the *step* instead of to the property page to start over.
     */
    resumeToken?: string;
    /**
     * Only on holds. An N-room booking is N `Reservation` rows sharing one hold; this
     * lists them all, so a "confirmed"/"cancelled" for ANY of them supersedes the hold.
     */
    reservationIds?: string[];
    roomsCount?: number;
    [key: string]: unknown;
}

/** `notificationView` as returned by GET /v1/inbox and GET /v1/notifications/{id}. */
export interface InboxNotification {
    id: string;
    notificationType: string;
    status: string;
    recipientUserId: string;
    payload: NotificationPayload;
    createdAt: string;
    readAt: string | null;
    archivedAt: string | null;
}

/** What our own /api/notifications routes hand to the browser. */
export interface InboxResponse {
    notifications: InboxNotification[];
    nextCursor: string | null;
    /** Unread (status=SENT), stale holds already excluded. */
    unreadCount: number;
    /** Solo en /api/notifications/panel (el panel de la campana, paginado). */
    page?: number;
    pageCount?: number;
    total?: number;
}

export type InboxFilter = "unread" | "all" | "archived";

export const isUnread = (n: InboxNotification): boolean => n.status === "SENT" && !n.readAt;

/**
 * Where a notification takes the user. The payload deliberately carries no
 * absolute URL (it is written by qb-back, which must not know our routes), so
 * the destination is derived here — never taken from the payload.
 */
export const notificationHref = (payload: NotificationPayload): string | null => {
    // «Reserva en curso» is the one notification whose job is to RESUME something, not
    // to show it: it must land on the booking step, and that route only opens with the
    // signed token. Without one (older payload, or qb-back had no BEARER_TOKEN) we fall
    // through to the reservation summary rather than send the user somewhere broken.
    if (payload.resumeToken) {
        return `/booking?secure=${encodeURIComponent(payload.resumeToken)}`;
    }
    if (payload.role === "owner") {
        return payload.reservationId ? `/profile/org-reservations/${payload.reservationId}` : null;
    }
    if (payload.kind === "invoice") {
        return payload.invoiceId ? `/profile/invoices/${payload.invoiceId}` : null;
    }
    if (payload.kind === "reservation") {
        return payload.reservationId ? `/profile/reservations/${payload.reservationId}` : null;
    }
    return null;
};

/**
 * Drops "reserva en curso" notifications that no longer describe reality: the
 * hold expired, or the reservation it points at was since confirmed/cancelled.
 * Showing one would invite the user to "continue" a reservation that is gone.
 *
 * `context` is a wider slice of the user's inbox (all statuses) used to spot the
 * superseding events even when they fall outside the requested page.
 */
export const dropStaleHolds = (
    items: InboxNotification[],
    context: InboxNotification[] = items,
    now: number = Date.now(),
): InboxNotification[] => {
    const supersededReservationIds = new Set(
        context
            .filter(
                (n) =>
                    n.notificationType === "reservation_confirmed" ||
                    n.notificationType === "reservation_cancelled",
            )
            .map((n) => n.payload?.reservationId)
            .filter((id): id is string => Boolean(id)),
    );

    return items.filter((n) => {
        if (n.notificationType !== "reservation_hold_active") return true;
        // Check every room of the booking, not just the first: the superseding event is
        // emitted once per group, carrying whichever sibling id won the race.
        const held = [n.payload?.reservationId, ...(n.payload?.reservationIds ?? [])].filter(
            (id): id is string => Boolean(id),
        );
        if (held.some((id) => supersededReservationIds.has(id))) return false;
        const expiresAt = n.payload?.expiresAt;
        if (expiresAt) {
            const expiry = Date.parse(expiresAt);
            if (!Number.isNaN(expiry) && expiry <= now) return false;
        }
        return true;
    });
};
