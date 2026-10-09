/**
 * El panel de la campana: unos pocos avisos por página.
 *
 * Todo puro y sin red, para poder probarlo. Notify solo pagina por cursor y no dice
 * cuántos hay, así que «página X de Y» sale de aquí: se piden de una vez los más
 * recientes y se trocean en memoria.
 *
 * ponytail: el tope son los PANEL_FETCH_LIMIT más recientes (20 páginas). Lo anterior
 * está en el centro de avisos (/profile/notifications). Si hiciera falta «de verdad
 * todos», habría que pedirle a Notify un total o pasar a cursor.
 */
import { dropStaleHolds, isUnread, type InboxNotification, type InboxResponse } from "./types";

export const PANEL_PAGE_SIZE = 5;
/** Lo máximo que Notify devuelve en una petición (maxPageLimit en su backend). */
export const PANEL_FETCH_LIMIT = 100;

/** `?page=` de la petición → entero ≥ 1. Cualquier otra cosa es la primera página. */
export const parsePagina = (value: string | null): number => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? n : 1;
};

/**
 * La página pedida de los avisos de esta persona. Una página fuera de rango se
 * recorta a la última (la lista puede haber encogido entre dos peticiones: se archivó
 * o expiró algo) y nunca devuelve «página 0» ni una página vacía a no ser que no haya
 * nada.
 */
export const paginarAvisos = (
    todos: InboxNotification[],
    pedida: number,
    tamano: number = PANEL_PAGE_SIZE,
): { notifications: InboxNotification[] } & Required<Pick<InboxResponse, "unreadCount" | "page" | "pageCount" | "total">> => {
    const vivos = dropStaleHolds(todos.filter((n) => !n.archivedAt));
    const pageCount = Math.max(1, Math.ceil(vivos.length / tamano));
    const page = Math.min(Math.max(1, pedida), pageCount);
    return {
        notifications: vivos.slice((page - 1) * tamano, page * tamano),
        page,
        pageCount,
        total: vivos.length,
        unreadCount: vivos.filter(isUnread).length,
    };
};

/**
 * A qué página lleva «anterior» (`delta` -1) o «siguiente» (+1) desde `page`, o `null` si
 * ya está en el borde. Los botones de página NO se apagan con `disabled` (un botón que se
 * apaga mientras tiene el foco lo pierde y el teclado se queda sin sitio): quedan con
 * `aria-disabled` y su pulsación no hace nada porque aquí sale `null`.
 */
export const paginaDestino = (page: number, pageCount: number, delta: -1 | 1): number | null => {
    const destino = page + delta;
    return destino >= 1 && destino <= pageCount ? destino : null;
};

/**
 * Cuántos sin leer decir. Notify solo da los `PANEL_FETCH_LIMIT` más recientes: si la
 * lista llega a ese tope puede haber más de los que se ven, y un número exacto infravaloraría.
 * Entonces es una cota inferior: «N+» (o «100+» si ya están todos sin leer). Nunca un número
 * que parezca exacto cuando no lo es.
 */
export const etiquetaSinLeer = (sinLeer: number, total: number, tope: number = PANEL_FETCH_LIMIT): string => {
    if (total < tope) return String(sinLeer);
    return sinLeer >= tope ? `${tope}+` : `${sinLeer}+`;
};
