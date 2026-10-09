"use client";

/**
 * Notification detail. Loads through /api/notifications/{id}, which 403s unless
 * the notification belongs to the session user — the upstream inbox API is only
 * application-scoped, so that check is what keeps inboxes apart.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button, Chip } from "@heroui/react";
import { ProfilePageShell } from "@/components/profile/profile-page-shell";
import { Icons } from "@/components/icons/iconify";
import type { AvisoVista } from "@/lib/notify/types";
import { marcarLeidoUnaVez } from "@/lib/notify/marcar-una-vez";
import {
    absoluteTime,
    notificationBody,
    notificationColor,
    notificationTitle,
} from "@/lib/notify/format";

export default function NotificationDetailPage() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const t = useTranslations();
    const locale = useLocale();

    const id = params?.id;
    const [notification, setNotification] = useState<AvisoVista | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        if (!id) return;
        try {
            const res = await fetch(`/api/notifications/${encodeURIComponent(id)}`, {
                credentials: "include",
                cache: "no-store",
            });
            if (!res.ok) {
                setNotification(null);
                return;
            }
            const data = (await res.json()) as { notification: AvisoVista | null };
            setNotification(data.notification ?? null);
        } catch {
            setNotification(null);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    // Opening the detail is reading it — UNA vez por aviso (ver marcar-una-vez.ts): si el POST
    // falla no se reintenta en bucle con cada recarga.
    const intentados = useRef(new Set<string>());
    useEffect(() => {
        void marcarLeidoUnaVez(
            notification,
            intentados.current,
            async (avisoId) => {
                const res = await fetch(`/api/notifications/${encodeURIComponent(avisoId)}/read`, {
                    method: "POST",
                    credentials: "include",
                });
                return res.ok;
            },
            load,
        );
    }, [notification, load]);

    const act = async (action: "read" | "archive" | "unarchive") => {
        if (!notification) return;
        setBusy(true);
        try {
            await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/${action}`, {
                method: "POST",
                credentials: "include",
            });
            await load();
        } finally {
            setBusy(false);
        }
    };

    const shell = (children: React.ReactNode, title: string) => (
        <ProfilePageShell
            title={title}
            backPath="/profile/notifications"
        >
            {children}
        </ProfilePageShell>
    );

    if (loading) {
        return shell(
            <div className="py-12 text-center text-gray-400">
                {t("profilePages.notifications.loading")}
            </div>,
            t("profilePages.notifications.title"),
        );
    }

    if (!notification) {
        return shell(
            <div className="py-12 text-center">
                <p className="mb-4 text-gray-400">{t("profilePages.notificationDetail.notFoundBody")}</p>
                <Button size="sm" variant="bordered" startContent={<Icons.arrowLeft className="size-4" />} onPress={() => router.push("/profile/notifications")}>
                    {t("profilePages.notificationDetail.backToNotifications")}
                </Button>
            </div>,
            t("profilePages.notificationDetail.notFoundTitle"),
        );
    }

    const href = notification.href ?? null;
    const read = Boolean(notification.readAt);

    return shell(
        <div className="space-y-4">
            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-2">
                <Chip radius="sm" size="sm" color={notificationColor(notification.payload)} variant="flat">
                    {notification.payload.propertyName ?? notification.notificationType}
                </Chip>
                {read ? (
                    <Chip radius="sm" size="sm" color="default" variant="flat">
                        {t("cards.read")}
                    </Chip>
                ) : (
                    <Chip radius="sm" size="sm" color="primary" variant="solid">
                        {t("profilePages.notifications.new")}
                    </Chip>
                )}
                {notification.archivedAt && (
                    <Chip radius="sm" size="sm" color="default" variant="flat">
                        {t("profilePages.notifications.filters.archived")}
                    </Chip>
                )}
                <span className="text-xs text-gray-400">{absoluteTime(notification.createdAt, locale)}</span>
            </div>

            {/* Content — the API renders nothing; the copy lives in the payload. */}
            <div
                className={`rounded-sm border p-4 ${
                    read
                        ? "border-gray-100 bg-gray-50 dark:border-slate-700 dark:bg-slate-800"
                        : "border-blue-100 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-900/20"
                }`}
            >
                <h2 className="mb-2 text-base font-semibold text-gray-900 dark:text-white">
                    {notificationTitle(notification)}
                </h2>
                <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                    {notificationBody(notification)}
                </p>
            </div>

            {/* Stay dates, when the payload carries them */}
            {(notification.payload.checkIn || notification.payload.code) && (
                <div className="grid gap-2 rounded-sm border border-gray-100 bg-gray-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800 sm:grid-cols-3">
                    {notification.payload.code && (
                        <div>
                            <p className="text-xs text-gray-400">{t("profilePages.notifications.codeLabel")}</p>
                            <p className="font-mono text-gray-700 dark:text-gray-300">{notification.payload.code}</p>
                        </div>
                    )}
                    {notification.payload.checkIn && (
                        <div>
                            <p className="text-xs text-gray-400">{t("profilePages.notifications.checkInLabel")}</p>
                            <p className="text-gray-700 dark:text-gray-300">{notification.payload.checkIn}</p>
                        </div>
                    )}
                    {notification.payload.checkOut && (
                        <div>
                            <p className="text-xs text-gray-400">{t("profilePages.notifications.checkOutLabel")}</p>
                            <p className="text-gray-700 dark:text-gray-300">{notification.payload.checkOut}</p>
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
                {!read && (
                    <Button
                        size="sm"
                        variant="bordered"
                        color="primary"
                        isDisabled={busy}
                        startContent={<Icons.eye className="size-4" />}
                        onPress={() => void act("read")}
                    >
                        {t("profilePages.notifications.markAsRead")}
                    </Button>
                )}

                {href && (
                    <Button
                        size="sm"
                        variant="bordered"
                        color="secondary"
                        startContent={<Icons.chevronRight className="size-4" />}
                        onPress={() => router.push(href)}
                    >
                        {t("profilePages.notifications.viewDetail")}
                    </Button>
                )}

                {notification.archivedAt ? (
                    <Button
                        size="sm"
                        variant="bordered"
                        isDisabled={busy}
                        startContent={<Icons.eyeClosed className="size-4" />}
                        onPress={() => void act("unarchive")}
                    >
                        {t("profilePages.notifications.unarchive")}
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        variant="bordered"
                        color="danger"
                        isDisabled={busy}
                        startContent={<Icons.trashIcon className="size-4" />}
                        onPress={() => void act("archive")}
                    >
                        {t("profilePages.notifications.archive")}
                    </Button>
                )}
            </div>
        </div>,
        notificationTitle(notification),
    );
}
