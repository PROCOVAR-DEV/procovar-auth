/** Presentation helpers for inbox notifications. Client-safe (no secrets). */
import { esObjetoPlano, type AvisoVista, type InboxNotification } from "./types";

/** Lo mínimo que estas funciones leen de un aviso: vale tanto la fila de Notify como `AvisoVista`. */
type ConTitulo = Pick<InboxNotification, "notificationType"> & Pick<AvisoVista, "payload">;

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/** "hace 5 min" / "5 min ago", in the user's locale. Falls back to the raw date. */
export const relativeTime = (iso: string, locale: string): string => {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return iso;

    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    let duration = (time - Date.now()) / 1000;
    for (const division of DIVISIONS) {
        if (Math.abs(duration) < division.amount) {
            return formatter.format(Math.round(duration), division.unit);
        }
        duration /= division.amount;
    }
    return iso;
};

export const absoluteTime = (iso: string, locale: string): string => {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return iso;
    return new Date(time).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};

/**
 * El payload lo escribe el emisor y nadie lo valida: un título que llegue como número,
 * objeto o lista no debe tumbar la página (`.trim()` sobre eso lanza y no hay `error.tsx`).
 * Lo que no es texto cuenta como vacío. React escapa el HTML, así que no se toca.
 */
const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The API renders nothing: the emitter (qb-back) puts the copy in the payload.
 * If it is missing we fall back to the notification type rather than showing an
 * empty row.
 */
export const notificationTitle = (n: ConTitulo): string =>
    texto(n.payload?.title) || String(n.notificationType ?? "").replace(/_/g, " ");

export const notificationBody = (n: Pick<AvisoVista, "payload">): string => texto(n.payload?.body);

/** Chip colour by what the notification is about. Tolera un payload `null` o de tipo raro. */
export const notificationColor = (payload: unknown): "primary" | "success" | "warning" | "default" => {
    if (!esObjetoPlano(payload)) return "default";
    if (payload.role === "owner") return "warning";
    if (payload.kind === "invoice") return "success";
    if (payload.kind === "reservation") return "primary";
    return "default";
};

/**
 * Adónde lleva un aviso al pulsarlo: su destino (calculado en el servidor) o, si no tiene,
 * el detalle. El id se codifica: viene de otro servicio y no debe poder salirse de la ruta.
 */
export const rutaDetalle = (id: string): string => `/profile/notifications/${encodeURIComponent(id)}`;
export const destinoAviso = (n: Pick<AvisoVista, "id" | "href">): string => n.href || rutaDetalle(n.id);
