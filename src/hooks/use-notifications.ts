"use client";

/**
 * Reads the inbox through our own /api/notifications routes — never QB Notify
 * directly: the HMAC key is application-scoped and stays on the server. Note
 * that no userId is sent anywhere below; the server takes it from the session.
 *
 * SIN SONDEO. No hay `setInterval` ni `EventSource`: la lista y el contador se
 * refrescan al montar, al cambiar de página/filtro, al volver a la pestaña
 * (foco o visibilidad), cuando el componente llama a `refresh()` (la campana lo
 * hace al abrir el panel) y tras cada acción (marcar leído, archivar). Jose no
 * quiere un reguero de peticiones por detrás. Cuando toque hacerlo por eventos,
 * ver «Tiempo real» en docs/avisos-por-aplicacion.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { marcarVarios, type ResultadoMarcar } from "@/lib/notify/marcar-varios";
import type { AvisoVista, InboxFilter, InboxResponse } from "@/lib/notify/types";

/** Volver a la pestaña dispara `focus` y `visibilitychange` a la vez: una sola petición. */
const REFRESCO_MIN_MS = 1_000;

type Accion = "read" | "archive" | "unarchive";

/** POST de una acción sobre un aviso. Nunca lanza: `false` si algo falló. */
const accionar = async (id: string, accion: Accion): Promise<boolean> => {
    try {
        const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/${accion}`, {
            method: "POST",
            credentials: "include",
        });
        return res.ok;
    } catch {
        return false;
    }
};

interface UseNotificationsOptions {
    filter?: InboxFilter;
    limit?: number;
    /** Refresca al volver a la pestaña (foco / visibilidad). La campana lo quiere; una página de detalle no. */
    live?: boolean;
    /** Si se pasa, pide esa página al panel paginado (/api/notifications/panel) en vez de `filter`/`limit`. */
    page?: number;
}

export interface PageInfo {
    page: number;
    pageCount: number;
    total: number;
}

export function useNotifications({ filter = "all", limit = 20, live = false, page }: UseNotificationsOptions = {}) {
    const [notifications, setNotifications] = useState<AvisoVista[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
    const [loading, setLoading] = useState(true);
    // El servicio de avisos no contestó: distinto de «no hay avisos».
    const [error, setError] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [markingAll, setMarkingAll] = useState(false);
    // Avoids a slow response for a filter the user already left overwriting the new one.
    const requestId = useRef(0);
    const lastRefresh = useRef(0);

    const load = useCallback(async () => {
        const current = ++requestId.current;
        lastRefresh.current = Date.now();
        try {
            const url =
                page === undefined
                    ? `/api/notifications?filter=${filter}&limit=${limit}`
                    : `/api/notifications/panel?page=${page}`;
            const res = await fetch(url, { credentials: "include", cache: "no-store" });
            const data = res.ok ? ((await res.json()) as InboxResponse) : null;
            if (current !== requestId.current) return;
            setError(!data);
            if (!data) return;
            setNotifications(data.notifications ?? []);
            setUnreadCount(data.unreadCount ?? 0);
            if (data.pageCount) setPageInfo({ page: data.page ?? 1, pageCount: data.pageCount, total: data.total ?? 0 });
        } catch {
            // Notifications are a side channel: a failure must not break the page.
            if (current === requestId.current) setError(true);
        } finally {
            if (current === requestId.current) setLoading(false);
        }
    }, [filter, limit, page]);

    // Todo lo que corre FUERA de un render (focus, acciones, la campana) llama a la
    // versión más reciente de `load` a través de este ref: si capturara la suya, tras un
    // cambio de página seguiría pidiendo la página vieja.
    const loadRef = useRef(load);
    useEffect(() => {
        loadRef.current = load;
    }, [load]);
    const refresh = useCallback(() => loadRef.current(), []);

    useEffect(() => {
        setLoading(true);
        void load();
    }, [load]);

    useEffect(() => {
        if (!live) return;
        const alVolver = () => {
            if (document.visibilityState !== "visible") return;
            if (Date.now() - lastRefresh.current < REFRESCO_MIN_MS) return;
            void loadRef.current();
        };
        window.addEventListener("focus", alVolver);
        document.addEventListener("visibilitychange", alVolver);
        return () => {
            window.removeEventListener("focus", alVolver);
            document.removeEventListener("visibilitychange", alVolver);
        };
    }, [live]);

    const act = useCallback(async (id: string, accion: Accion) => {
        setPending(id);
        try {
            const ok = await accionar(id, accion);
            if (ok) await loadRef.current();
            return ok;
        } finally {
            setPending(null);
        }
    }, []);

    const markRead = useCallback((id: string) => act(id, "read"), [act]);
    const archive = useCallback((id: string) => act(id, "archive"), [act]);
    const unarchive = useCallback((id: string) => act(id, "unarchive"), [act]);

    /** Marca leídos estos avisos (tope y paralelismo en `marcarVarios`) y refresca UNA vez. */
    const markAllRead = useCallback(async (ids: string[]): Promise<ResultadoMarcar> => {
        setMarkingAll(true);
        try {
            return await marcarVarios(ids, (id) => accionar(id, "read"));
        } finally {
            await loadRef.current();
            setMarkingAll(false);
        }
    }, []);

    const archiveAllRead = useCallback(async () => {
        try {
            const res = await fetch("/api/notifications/archive-read", {
                method: "POST",
                credentials: "include",
            });
            if (!res.ok) return false;
            await loadRef.current();
            return true;
        } catch {
            return false;
        }
    }, []);

    return {
        notifications,
        unreadCount,
        loading,
        error,
        pageInfo,
        pending,
        markingAll,
        refresh,
        markRead,
        markAllRead,
        archive,
        unarchive,
        archiveAllRead,
    };
}
