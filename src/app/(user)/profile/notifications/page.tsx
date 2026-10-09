"use client";

/**
 * Notification centre — the full inbox behind the header bell.
 *
 * Backed by /api/notifications (session-scoped server side); this component
 * never sends a userId and never talks to QB Notify directly. All copy comes
 * from `payload.title` / `payload.body`: the inbox API renders nothing.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@heroui/react";
import { ProfilePageShell } from "@/components/profile/profile-page-shell";
import { Icons } from "@/components/icons/iconify";
import { useNotifications } from "@/hooks/use-notifications";
import { isUnread, type AvisoVista, type InboxFilter } from "@/lib/notify/types";
import { destinoAviso, rutaDetalle } from "@/lib/notify/format";
import { ErrorDelCentro, FilaDeAviso } from "./piezas-del-centro";

const FILTERS: InboxFilter[] = ["unread", "all", "archived"];

export default function NotificationsPage() {
    const router = useRouter();
    const t = useTranslations();
    const [filter, setFilter] = useState<InboxFilter>("all");

    const {
        notifications,
        unreadCount,
        loading,
        error,
        refresh,
        pending,
        markingAll,
        markRead,
        markAllRead,
        archive,
        unarchive,
        archiveAllRead,
    } = useNotifications({ filter, limit: 50 });
    // Cuántos avisos no se pudieron marcar en la última pulsación de «marcar todo».
    const [failedMarks, setFailedMarks] = useState(0);
    const unreadIds = notifications.filter(isUnread).map((n) => n.id);

    const markAll = async () => {
        setFailedMarks(0);
        const { fallidos } = await markAllRead(unreadIds);
        setFailedMarks(fallidos);
    };

    const open = (n: AvisoVista) => {
        if (isUnread(n)) void markRead(n.id);
        router.push(rutaDetalle(n.id));
    };

    const go = (n: AvisoVista) => {
        if (isUnread(n)) void markRead(n.id);
        // El destino lo calcula el servidor a partir del payload — qb-back no manda URLs, a propósito.
        if (n.href) router.push(destinoAviso(n));
    };

    return (
        <ProfilePageShell
            rotulo={t('nav.profile')}
            title={t("profilePages.notifications.title")}
            count={notifications.length}
        >
            {/* Toolbar */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                    {FILTERS.map((value) => (
                        <button
                            key={value}
                            onClick={() => setFilter(value)}
                            className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${
                                filter === value
                                    ? "bg-blue-600 text-white"
                                    : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-400 dark:hover:bg-slate-700"
                            }`}
                        >
                            {t(`profilePages.notifications.filters.${value}`)}
                            {value === "unread" && unreadCount > 0 && ` (${unreadCount})`}
                        </button>
                    ))}
                </div>

                {filter !== "archived" && (
                    <div className="flex flex-wrap gap-2">
                        {unreadIds.length > 0 && (
                            <Button
                                size="sm"
                                variant="bordered"
                                className="text-xs"
                                startContent={<Icons.eye className="size-4" />}
                                isDisabled={markingAll}
                                onPress={() => void markAll()}
                            >
                                {markingAll ? t("avisosPanel.marcandoTodo") : t("avisosPanel.marcarTodo")}
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="bordered"
                            className="text-xs"
                            startContent={<Icons.archive className="size-4" />}
                            onPress={() => void archiveAllRead()}
                        >
                            {t("profilePages.notifications.archiveAllRead")}
                        </Button>
                    </div>
                )}
            </div>

            {failedMarks > 0 && (
                <p role="alert" className="mb-3 text-xs font-medium text-red-600 dark:text-red-400">
                    {t("avisosPanel.marcarTodoError", { n: failedMarks })}
                </p>
            )}

            {/* List */}
            {loading ? (
                <div className="py-12 text-center text-gray-400">
                    {t("profilePages.notifications.loading")}
                </div>
            ) : error ? (
                <ErrorDelCentro onRetry={() => void refresh()} />
            ) : (
                <div className="grid gap-2">
                    {notifications.map((n) => (
                        <FilaDeAviso
                            key={n.id}
                            aviso={n}
                            ocupado={pending === n.id}
                            onOpen={open}
                            onGo={go}
                            onMarkRead={(id) => void markRead(id)}
                            onArchive={(id) => void archive(id)}
                            onUnarchive={(id) => void unarchive(id)}
                        />
                    ))}

                    {notifications.length === 0 && (
                        <div className="py-12 text-center text-gray-400">
                            {t("profilePages.notifications.empty")}
                        </div>
                    )}
                </div>
            )}
        </ProfilePageShell>
    );
}
