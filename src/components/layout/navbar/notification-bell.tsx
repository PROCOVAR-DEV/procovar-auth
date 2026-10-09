"use client";

/**
 * La campana de la cabecera y su panel emergente.
 *
 * El panel cuelga de la campana (ventana anclada a ella en el escritorio, ancha de
 * borde a borde en el móvil) y enseña 5 avisos por página con «Página X de Y». Los
 * avisos son los de la persona de la sesión y salen de Notify a través de
 * /api/notifications/panel; este componente nunca ve un userId, una URL de Notify ni
 * la clave HMAC.
 *
 * Accesibilidad: la campana anuncia cuántos hay sin leer, abre un diálogo no modal, el
 * foco entra en él al abrir, Esc lo cierra devolviendo el foco a la campana, y también
 * se cierra al pulsar fuera o al sacar el foco del panel.
 *
 * Marcar leído: solo al pulsar un aviso (la operación por aviso ya existe en Notify).
 * «Marcar todo como leído» y archivar están en el centro de avisos (/profile/notifications),
 * al que lleva el botón del pie.
 *
 * Sin sondeo: el contador y la lista se refrescan al montar, al volver a la pestaña, AL
 * ABRIR el panel y tras marcar leído. Cerrado no hay ninguna petición por detrás.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@heroui/react";
import { Icons } from "@/components/icons/iconify";
import { authClient } from "@/lib/auth-client";
import { useNotifications } from "@/hooks/use-notifications";
import { destinoAviso } from "@/lib/notify/format";
import { etiquetaSinLeer } from "@/lib/notify/panel";
import { isUnread, type AvisoVista } from "@/lib/notify/types";
import { PanelDeAvisos } from "./panel-de-avisos";

export function NotificationBell() {
    const t = useTranslations("avisosPanel");
    const tArreglos = useTranslations("avisosArreglos");
    const router = useRouter();
    const { data: session } = authClient.useSession();
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(1);
    const ref = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const panelId = useId();
    const tituloId = `${panelId}-titulo`;

    const { notifications, unreadCount, loading, error, pageInfo, markRead, refresh } = useNotifications({
        live: true,
        page,
    });
    // Lo que dice el servidor manda: si recortó la página pedida (la lista encogió),
    // se muestra la que de verdad es.
    const paginaActual = pageInfo?.page ?? 1;
    const paginas = pageInfo?.pageCount ?? 1;
    // Notify solo da los 100 más recientes: con la lista al tope, el número es una cota («100+»).
    const sinLeerTexto = etiquetaSinLeer(unreadCount, pageInfo?.total ?? 0);

    const cerrar = () => setOpen(false);

    // Al abrir se pide lo último, y siempre desde la primera página. Si ya estaba en la 1
    // no cambia `page` (y no se dispararía la carga), así que se refresca a mano; si no,
    // volver a la 1 ya provoca la carga: una sola petición en cualquier caso.
    const abrir = () => {
        setOpen(true);
        if (page === 1) void refresh();
        else setPage(1);
    };

    useEffect(() => {
        if (!open) return;
        panelRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            triggerRef.current?.focus();
        };
        const onPointer = (event: PointerEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onPointer);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerdown", onPointer);
        };
    }, [open]);

    // Logged out there is no inbox — and no point showing a bell.
    if (!session?.user) return null;

    const select = (n: AvisoVista) => {
        cerrar();
        if (isUnread(n)) void markRead(n.id);
        // El destino lo calcula el servidor (`href`); sin él, el detalle, con el id codificado.
        router.push(destinoAviso(n));
    };

    return (
        <div
            className="relative"
            ref={ref}
            onBlur={(event) => {
                // El foco salió del panel y de la campana (Tab hacia fuera): se cierra.
                if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) cerrar();
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                onClick={() => (open ? cerrar() : abrir())}
                className={cn(
                    "relative inline-flex size-9 items-center justify-center border border-pv-trazo text-pv-tinta transition-colors hover:bg-pv-azul-tinte",
                    open && "bg-pv-azul-tinte",
                )}
                style={{ borderRadius: "var(--pv-radio)" }}
                aria-label={unreadCount > 0 ? t("campanaConNoLeidosAria", { n: sinLeerTexto }) : t("campanaAria")}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
            >
                <Icons.bell className="size-5" aria-hidden />
                {unreadCount > 0 && (
                    <span
                        aria-hidden
                        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-pv-azul px-0.5 text-[10px] font-bold leading-none tabular-nums text-pv-blanco"
                    >
                        {unreadCount > 9 ? "9+" : sinLeerTexto}
                    </span>
                )}
            </button>

            {/* Región viva: se anuncia «N sin leer» cuando termina de cargar, sin abrir el panel. */}
            <span role="status" className="sr-only">
                {!loading && !error && unreadCount > 0 ? tArreglos("sinLeerEstado", { n: sinLeerTexto }) : ""}
            </span>

            {open && (
                <div
                    ref={panelRef}
                    id={panelId}
                    role="dialog"
                    aria-labelledby={tituloId}
                    tabIndex={-1}
                    // Móvil: de borde a borde bajo la cabecera, para no salirse de 390 px.
                    // Escritorio: anclado a la campana.
                    className="fixed inset-x-4 top-[3.75rem] z-[300] flex max-h-[calc(100svh-5rem)] flex-col overflow-hidden border border-pv-trazo bg-pv-blanco text-pv-tinta shadow-xl outline-none sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-96"
                    style={{ borderRadius: "var(--pv-radio-grande)" }}
                >
                    <PanelDeAvisos
                        avisos={notifications}
                        cargando={loading}
                        error={error}
                        page={paginaActual}
                        pageCount={paginas}
                        sinLeer={unreadCount}
                        sinLeerTexto={sinLeerTexto}
                        tituloId={tituloId}
                        onPage={setPage}
                        onSelect={select}
                        onRetry={() => void refresh()}
                        onGestionar={cerrar}
                    />
                </div>
            )}
        </div>
    );
}
