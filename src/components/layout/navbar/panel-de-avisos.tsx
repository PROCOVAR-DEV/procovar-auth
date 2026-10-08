"use client";

/**
 * El contenido del panel que cuelga de la campana: cabecera, avisos de la página,
 * paginación y el botón «Gestionar avisos».
 *
 * Es solo presentación (todo llega por props) para poder pintarlo y probarlo en cada
 * estado sin red: cargando, error, vacío, con avisos. El contenedor —la ventana, el
 * foco, el Esc— lo pone `notification-bell.tsx`.
 *
 * Un fallo del servicio de avisos se queda DENTRO del panel: no sube a la cabecera ni
 * toca el resto de la página.
 */
import NextLink from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@heroui/react";
import { Icons } from "@/components/icons/iconify";
import { notificationBody, notificationTitle, relativeTime } from "@/lib/notify/format";
import type { InboxNotification } from "@/lib/notify/types";

export interface PanelDeAvisosProps {
    avisos: InboxNotification[];
    cargando: boolean;
    error: boolean;
    page: number;
    pageCount: number;
    sinLeer: number;
    onPage: (page: number) => void;
    onSelect: (aviso: InboxNotification) => void;
    onRetry: () => void;
    /** Se pulsó «Gestionar avisos»: el contenedor cierra el panel. */
    onGestionar: () => void;
}

const botonPagina =
    "inline-flex size-9 items-center justify-center border border-pv-trazo text-pv-tinta transition-colors hover:bg-pv-azul-tinte disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export function PanelDeAvisos(p: PanelDeAvisosProps) {
    const t = useTranslations("avisosPanel");
    const locale = useLocale();
    const primeraCarga = p.cargando && p.avisos.length === 0;

    return (
        <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-pv-trazo-tenue px-4 py-3">
                <h2 className="pv-rotulo">{t("titulo")}</h2>
                {p.sinLeer > 0 && <span className="pv-etiqueta pv-etiqueta-azul">{t("noLeidos", { n: p.sinLeer })}</span>}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-busy={p.cargando}>
                {p.error ? (
                    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-8 text-center">
                        <p className="text-sm font-semibold text-pv-cuno">{t("error")}</p>
                        <p className="text-xs text-pv-tinta-suave">{t("errorPista")}</p>
                        <button
                            type="button"
                            onClick={p.onRetry}
                            className="mt-1 inline-flex min-h-9 items-center gap-1.5 border border-pv-trazo px-3 text-xs font-semibold text-pv-tinta transition-colors hover:bg-pv-azul-tinte"
                        >
                            <Icons.refresh className="size-3.5" aria-hidden />
                            {t("reintentar")}
                        </button>
                    </div>
                ) : primeraCarga ? (
                    <p className="px-6 py-10 text-center text-sm text-pv-tinta-suave">{t("cargando")}</p>
                ) : p.avisos.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                        <Icons.bell className="size-5 text-pv-tinta-suave" aria-hidden />
                        <p className="text-sm font-semibold text-pv-tinta">{t("vacio")}</p>
                        <p className="text-xs text-pv-tinta-suave">{t("vacioPista")}</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-pv-trazo-tenue">
                        {p.avisos.map((n) => {
                            const sinLeer = !n.readAt;
                            return (
                                <li key={n.id}>
                                    <button
                                        type="button"
                                        onClick={() => p.onSelect(n)}
                                        className={cn(
                                            "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-pv-azul-tinte focus-visible:bg-pv-azul-tinte",
                                            sinLeer && "bg-pv-azul-tinte/50",
                                        )}
                                    >
                                        <span
                                            aria-hidden
                                            className={cn(
                                                "mt-1.5 size-2 shrink-0 rounded-full",
                                                sinLeer ? "bg-pv-azul" : "bg-pv-trazo",
                                            )}
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-baseline justify-between gap-2">
                                                <span
                                                    className={cn(
                                                        "truncate text-sm leading-snug",
                                                        sinLeer ? "font-semibold text-pv-tinta" : "text-pv-tinta-suave",
                                                    )}
                                                >
                                                    {sinLeer && <span className="sr-only">{t("noLeido")}: </span>}
                                                    {notificationTitle(n)}
                                                </span>
                                                <span className="shrink-0 text-[11px] text-pv-tinta-suave">
                                                    {relativeTime(n.createdAt, locale)}
                                                </span>
                                            </span>
                                            <span className="mt-0.5 line-clamp-2 block text-xs text-pv-tinta-suave">
                                                {notificationBody(n)}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {!p.error && p.pageCount > 1 && (
                <nav
                    aria-label={t("paginacionAria")}
                    className="flex shrink-0 items-center justify-between gap-2 border-t border-pv-trazo-tenue px-4 py-2"
                >
                    <button
                        type="button"
                        className={botonPagina}
                        aria-label={t("anterior")}
                        disabled={p.cargando || p.page <= 1}
                        onClick={() => p.onPage(p.page - 1)}
                    >
                        <Icons.chevronLeft className="size-4" aria-hidden />
                    </button>
                    <span className="text-xs tabular-nums text-pv-tinta-suave" aria-live="polite" aria-atomic="true">
                        {t("pagina", { actual: p.page, total: p.pageCount })}
                    </span>
                    <button
                        type="button"
                        className={botonPagina}
                        aria-label={t("siguiente")}
                        disabled={p.cargando || p.page >= p.pageCount}
                        onClick={() => p.onPage(p.page + 1)}
                    >
                        <Icons.chevronRight className="size-4" aria-hidden />
                    </button>
                </nav>
            )}

            <NextLink
                href="/profile/notifications"
                onClick={p.onGestionar}
                className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 border-t border-pv-trazo bg-pv-papel px-4 text-xs font-semibold uppercase tracking-wider text-pv-azul transition-colors hover:bg-pv-azul-tinte"
            >
                {t("gestionar")}
                <Icons.arrowRight className="size-3.5" aria-hidden />
            </NextLink>
        </>
    );
}
