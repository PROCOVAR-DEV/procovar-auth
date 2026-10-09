"use client";

/**
 * Las piezas del centro de avisos que se pintan solas (para poder probarlas sin la
 * página entera): una fila de aviso y el bloque de «no se pudieron cargar».
 */
import { useLocale, useTranslations } from "next-intl";
import { Chip } from "@heroui/react";
import { Icons } from "@/components/icons/iconify";
import { notificationBody, notificationColor, notificationTitle, relativeTime } from "@/lib/notify/format";
import { isUnread, type AvisoVista } from "@/lib/notify/types";

export interface FilaDeAvisoProps {
    aviso: AvisoVista;
    /** Hay una acción en curso sobre este aviso. */
    ocupado: boolean;
    onOpen: (n: AvisoVista) => void;
    onGo: (n: AvisoVista) => void;
    onMarkRead: (id: string) => void;
    onArchive: (id: string) => void;
    onUnarchive: (id: string) => void;
}

const icono = "rounded-sm p-1.5 transition-colors hover:bg-gray-200 focus-visible:bg-gray-200 dark:hover:bg-slate-700";

export function FilaDeAviso({ aviso: n, ocupado, onOpen, onGo, onMarkRead, onArchive, onUnarchive }: FilaDeAvisoProps) {
    const t = useTranslations();
    const locale = useLocale();
    const unread = isUnread(n);

    return (
        <div
            className={`relative flex gap-3 rounded-sm border p-3 transition-colors md:p-4 ${
                unread
                    ? "border-blue-100 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-900/20"
                    : "border-gray-100 bg-gray-50 dark:border-slate-800 dark:bg-slate-800/50"
            }`}
        >
            <div
                aria-hidden
                className={`mt-1.5 size-2 shrink-0 rounded-sm ${unread ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"}`}
            />

            {/* Toda la fila abre el aviso (el ::after del botón del título la cubre), pero lo que se
                puede pulsar y enfocar con teclado es un <button> de verdad, no un <div onClick>. */}
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start gap-2">
                    <button
                        type="button"
                        onClick={() => onOpen(n)}
                        className={`min-w-0 flex-1 cursor-pointer break-words text-left text-sm font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${
                            unread ? "text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"
                        }`}
                    >
                        {notificationTitle(n)}
                    </button>
                    <div className="flex shrink-0 gap-1">
                        <Chip radius="sm" size="sm" color={notificationColor(n.payload)} variant="flat" className="text-xs">
                            {n.payload.propertyName ?? n.payload.code ?? n.notificationType}
                        </Chip>
                        {unread && (
                            <Chip radius="sm" size="sm" color="primary" variant="solid" className="text-xs">
                                {t("profilePages.notifications.new")}
                            </Chip>
                        )}
                    </div>
                </div>
                <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                    {notificationBody(n)}
                </p>
                <p className="mt-1 text-xs text-gray-400">{relativeTime(n.createdAt, locale)}</p>
            </div>

            {/* Actions: por encima del ::after para recibir su propio clic */}
            <div className="relative z-10 flex shrink-0 flex-col gap-1">
                {unread && (
                    <button
                        type="button"
                        title={t("profilePages.notifications.markAsRead")}
                        aria-label={t("profilePages.notifications.markAsRead")}
                        disabled={ocupado}
                        onClick={() => onMarkRead(n.id)}
                        className={icono}
                    >
                        <Icons.eye className="size-4 text-blue-500" aria-hidden />
                    </button>
                )}
                {n.href && (
                    <button
                        type="button"
                        title={t("profilePages.notifications.viewDetail")}
                        aria-label={t("profilePages.notifications.viewDetail")}
                        onClick={() => onGo(n)}
                        className={icono}
                    >
                        <Icons.chevronRight className="size-4 text-gray-400" aria-hidden />
                    </button>
                )}
                {n.archivedAt ? (
                    <button
                        type="button"
                        title={t("profilePages.notifications.unarchive")}
                        aria-label={t("profilePages.notifications.unarchive")}
                        disabled={ocupado}
                        onClick={() => onUnarchive(n.id)}
                        className={icono}
                    >
                        <Icons.eyeClosed className="size-4 text-gray-400" aria-hidden />
                    </button>
                ) : (
                    <button
                        type="button"
                        title={t("profilePages.notifications.archive")}
                        aria-label={t("profilePages.notifications.archive")}
                        disabled={ocupado}
                        onClick={() => onArchive(n.id)}
                        className={icono}
                    >
                        <Icons.trashIcon className="size-4 text-gray-400 hover:text-red-500" aria-hidden />
                    </button>
                )}
            </div>
        </div>
    );
}

/** El servicio de avisos no contestó: se dice, con reintento, y NO se pinta «sin avisos». */
export function ErrorDelCentro({ onRetry }: { onRetry: () => void }) {
    const t = useTranslations("avisosPanel");
    return (
        <div role="alert" className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">{t("error")}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("errorPista")}</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-gray-300 px-3 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:border-slate-600 dark:text-gray-300 dark:hover:bg-slate-800"
            >
                <Icons.refresh className="size-3.5" aria-hidden />
                {t("reintentar")}
            </button>
        </div>
    );
}
