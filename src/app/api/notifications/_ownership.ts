/**
 * Ownership guard shared by every /api/notifications route.
 *
 * QB Notify's inbox API is scoped by *application*, not by user: our HMAC key
 * can read and mutate any notification of this app, and `GET /v1/inbox?userId=`
 * happily accepts whatever userId it is given. So the two rules below are the
 * only thing standing between a user and someone else's inbox:
 *
 *  1. the userId always comes from the server-side session, never from the request;
 *  2. before touching a notification by id, we fetch it and check that it is the
 *     session user's.
 *
 * Un aviso AJENO contesta 404, igual que uno que no existe (antes 403): un 403 le diría a
 * quien prueba ids que ese id existe y es de otra persona. Y «Notify no contesta» es 502,
 * no 404: no es lo mismo «no existe» que «no se pudo mirar».
 */
import { NextResponse } from "next/server";
import { resolveSessionUser } from "@/lib/require-admin";
import { fetchNotification } from "@/lib/notify/inbox";
import type { InboxNotification } from "@/lib/notify/types";

/**
 * Los avisos son de UNA persona y salen de su cookie: ni una caché compartida (proxy,
 * CDN) ni el navegador deben guardar la respuesta, y si algo la guarda, que la separe por
 * cookie. En TODAS las respuestas de /api/notifications, también 401, 404 y 502.
 */
export const privada = (res: NextResponse): NextResponse => {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("Vary", "Cookie");
    return res;
};

/** 502: Notify no contestó. Distinto de «no hay avisos» y de «no existe». */
export const avisosNoDisponible = (): NextResponse =>
    privada(NextResponse.json({ error: "avisos_no_disponible" }, { status: 502 }));

/** The authenticated user id, or a 401 response. Never trusts the request body/query. */
export async function requireSessionUserId(): Promise<string | NextResponse> {
    const resolved = await resolveSessionUser();
    if (!resolved?.user?.id) {
        return privada(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    }
    return resolved.user.id;
}

/** The notification with `id`, but only if it belongs to the session user. */
export async function requireOwnedNotification(
    id: string,
): Promise<InboxNotification | NextResponse> {
    const userId = await requireSessionUserId();
    if (userId instanceof NextResponse) return userId;

    const found = await fetchNotification(id);
    if (found.kind === "failed") return avisosNoDisponible();
    // Ajeno = inexistente (mismo 404 y mismo cuerpo): no se revela que el id existe.
    if (found.kind === "not_found" || found.notification.recipientUserId !== userId) {
        return privada(NextResponse.json({ error: "not_found" }, { status: 404 }));
    }
    return found.notification;
}
