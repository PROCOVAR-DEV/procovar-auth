"use client";

/**
 * Reads the inbox through our own /api/notifications routes — never QB Notify
 * directly: the HMAC key is application-scoped and stays on the server. Note
 * that no userId is sent anywhere below; the server takes it from the session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxFilter, InboxNotification, InboxResponse } from "@/lib/notify/types";

const POLL_MS = 60_000;

interface UseNotificationsOptions {
    filter?: InboxFilter;
    limit?: number;
    /** Poll + refresh on window focus. The bell wants this; a detail page doesn't. */
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
    const [notifications, setNotifications] = useState<InboxNotification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
    const [loading, setLoading] = useState(true);
    // El servicio de avisos no contestó: distinto de «no hay avisos».
    const [error, setError] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    // Avoids a slow response for a filter the user already left overwriting the new one.
    const requestId = useRef(0);

    const refresh = useCallback(async () => {
        const current = ++requestId.current;
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

    useEffect(() => {
        setLoading(true);
        void refresh();
    }, [refresh]);

    /**
     * Tiempo real. qb-back publica un evento en el canal personal del usuario cada vez
     * que le nace una notificación o le cambia una reserva; aquí se escucha y se
     * refresca al instante, en todas las pestañas abiertas a la vez.
     *
     * El poll se queda, pero como RED DE SEGURIDAD, no como mecanismo principal: si el
     * SSE se cae (proxy, red, el navegador congela la pestaña), la campana sigue
     * actualizándose sola. EventSource ya reconecta por su cuenta.
     */
    useEffect(() => {
        if (!live) return;

        const interval = setInterval(() => void refresh(), POLL_MS);
        const onFocus = () => void refresh();
        window.addEventListener("focus", onFocus);

        // Sin orgId: es el canal personal (la campana). El servidor saca el userId de la
        // sesión — nunca se manda desde aquí.
        const es = new EventSource("/api/events");
        es.onmessage = (ev) => {
            try {
                const data = JSON.parse(ev.data) as { type?: string };
                if (data.type === "notification" || data.type === "reservation") void refresh();
            } catch {
                // Un evento ilegible no debe tumbar el stream.
            }
        };
        // onerror: no cerramos nada — EventSource reintenta solo, y el poll cubre el hueco.

        return () => {
            clearInterval(interval);
            window.removeEventListener("focus", onFocus);
            es.close();
        };
    }, [live, refresh]);

    const act = useCallback(
        async (id: string, action: "read" | "archive" | "unarchive") => {
            setPending(id);
            try {
                const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/${action}`, {
                    method: "POST",
                    credentials: "include",
                });
                if (!res.ok) return false;
                await refresh();
                return true;
            } catch {
                return false;
            } finally {
                setPending(null);
            }
        },
        [refresh],
    );

    const markRead = useCallback((id: string) => act(id, "read"), [act]);
    const archive = useCallback((id: string) => act(id, "archive"), [act]);
    const unarchive = useCallback((id: string) => act(id, "unarchive"), [act]);

    const archiveAllRead = useCallback(async () => {
        try {
            const res = await fetch("/api/notifications/archive-read", {
                method: "POST",
                credentials: "include",
            });
            if (!res.ok) return false;
            await refresh();
            return true;
        } catch {
            return false;
        }
    }, [refresh]);

    return { notifications, unreadCount, loading, error, pageInfo, pending, refresh, markRead, archive, unarchive, archiveAllRead };
}
