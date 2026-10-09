"use client";

import { useEffect, useReducer, useRef, type Ref } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Icon } from "@iconify/react";
import { Button, cn } from "@heroui/react";
import { Icons } from "@/components/icons/iconify";
import { describirAgente } from "@/lib/agente-de-usuario";
import type { FilaDeInicio, PaginaDeInicios } from "@/lib/historial-de-inicios";
import { paginaDestino } from "@/lib/notify/panel";

const ICONO: Record<FilaDeInicio["tipo"], string> = {
    navegador: "lucide:globe",
    aparato: "lucide:tablet-smartphone",
};

// Los botones de página son los de la campana (`panel-de-avisos.tsx`), con el mismo `aria-disabled`
// y no `disabled`: un botón que se apaga con el foco puesto lo pierde, y el teclado se queda sin sitio.
const botonPagina =
    "inline-flex size-9 items-center justify-center border border-pv-trazo text-pv-tinta transition-colors hover:bg-pv-azul-tinte aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent";

export interface EstadoDelHistorial {
    /** La última respuesta buena. NO se borra al cambiar de página ni al fallar: es lo que sigue a la vista. */
    datos: PaginaDeInicios | null;
    pedida: number;
    /** Sube en cada petición: aunque la página sea la misma («Reintentar»), el efecto vuelve a pedirla. */
    intento: number;
    cargando: boolean;
    error: boolean;
}

export type AccionDelHistorial =
    | { tipo: "pedir"; pagina: number }
    | { tipo: "llego"; datos: PaginaDeInicios }
    | { tipo: "fallo" };

export const estadoInicial: EstadoDelHistorial = { datos: null, pedida: 1, intento: 0, cargando: true, error: false };

export function reducir(e: EstadoDelHistorial, a: AccionDelHistorial): EstadoDelHistorial {
    switch (a.tipo) {
        case "pedir":
            return { ...e, pedida: a.pagina, intento: e.intento + 1, cargando: true, error: false };
        case "llego":
            return { ...e, datos: a.datos, cargando: false, error: false };
        case "fallo":
            return { ...e, cargando: false, error: true };
    }
}

function Alerta({ titulo, pista, onRetry }: { titulo: string; pista?: string; onRetry: () => void }) {
    const t = useTranslations("historial");
    return (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <div className="min-w-0 flex-1">
                <p className="font-semibold">{titulo}</p>
                {pista && <p className="text-pv-tinta-suave">{pista}</p>}
            </div>
            <Button size="sm" variant="bordered" onPress={onRetry}>
                {t("reintentar")}
            </Button>
        </div>
    );
}

export interface PropsDeLaLista {
    datos: PaginaDeInicios | null;
    cargando: boolean;
    error: boolean;
    /** La página que se está pidiendo (puede no ser la que se ve: la anterior sigue ahí hasta que llega). */
    pedida: number;
    onPage: (pagina: number) => void;
    onRetry: () => void;
    /** A él vuelve el foco al cambiar de página. */
    refCabecera?: Ref<HTMLHeadingElement>;
}

/** Solo presentación (todo llega por props) para poder pintarla y probarla en cada estado sin red. */
export function ListaDeInicios({ datos, cargando, error, pedida, onPage, onRetry, refCabecera }: PropsDeLaLista) {
    const t = useTranslations("historial");
    const locale = useLocale();

    const cuando = (iso: string) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

    // El nombre se arma con las partes del agente para poder decir «en»/«on» en cada idioma.
    const nombre = (f: FilaDeInicio) => {
        const { navegador, sistema } = describirAgente(f.ua);
        if (f.tipo === "aparato") return sistema ? t("appEn", { sistema }) : t("app");
        if (navegador && sistema) return t("nombre", { navegador, sistema });
        return navegador ?? sistema ?? t("sinNombre");
    };

    const ir = (delta: -1 | 1) => {
        if (!datos) return;
        const destino = paginaDestino(datos.pagina, datos.paginas, delta);
        if (destino !== null) onPage(destino);
    };

    return (
        <section aria-labelledby="historial-titulo" className="pv-ficha">
            <div className="pv-ficha-cabecera">
                <Icon icon="lucide:history" className="size-4 shrink-0 text-pv-tinta-suave" aria-hidden />
                <h2 id="historial-titulo" ref={refCabecera} tabIndex={-1} className="text-sm font-semibold outline-none">
                    {t("titulo")}
                </h2>
            </div>

            <div className="space-y-3 px-4 py-4">
                <p className="text-sm text-pv-tinta-suave">{t("ayuda")}</p>

                {datos === null && cargando && (
                    <p role="status" className="text-sm text-pv-tinta-suave">
                        {t("cargando")}
                    </p>
                )}

                {datos === null && error && <Alerta titulo={t("error")} pista={t("errorPista")} onRetry={onRetry} />}

                {datos && datos.total === 0 && <p className="text-sm text-pv-tinta-suave">{t("vacio")}</p>}

                {datos && datos.total > 0 && (
                    // Al pedir otra página la anterior se queda, atenuada, hasta que llega la nueva.
                    <div aria-busy={cargando} className={cn("transition-opacity", cargando && "opacity-50")}>
                        <ul aria-label={t("titulo")} className="divide-y divide-pv-trazo-tenue border-y border-pv-trazo-tenue">
                            {datos.filas.map((f) => (
                                <li key={f.id} className="flex items-start gap-3 py-3">
                                    <Icon icon={ICONO[f.tipo]} className="mt-0.5 size-5 shrink-0 text-pv-azul" aria-hidden />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="min-w-0 break-words text-sm font-semibold">{nombre(f)}</span>
                                            {f.esActual && <span className="pv-etiqueta pv-etiqueta-visto">{t("estaSesion")}</span>}
                                            {!f.esActual && f.estaActiva === true && (
                                                <span className="pv-etiqueta pv-etiqueta-azul">{t("abierta")}</span>
                                            )}
                                            {f.estaActiva === false && <span className="pv-etiqueta pv-etiqueta-gris">{t("cerrada")}</span>}
                                        </div>
                                        <p className="mt-1 break-all text-xs text-pv-tinta-suave">
                                            {cuando(f.cuando)}
                                            {" · "}
                                            {f.ip ? t("ip", { ip: f.ip }) : t("sinIp")}
                                        </p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {datos && error && <Alerta titulo={t("errorPagina", { n: pedida })} onRetry={onRetry} />}

                {datos && datos.paginas > 1 && (
                    <nav aria-label={t("paginacionAria")} className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            className={botonPagina}
                            aria-label={t("anterior")}
                            aria-disabled={datos.pagina <= 1}
                            onClick={() => ir(-1)}
                        >
                            <Icons.chevronLeft className="size-4" aria-hidden />
                        </button>
                        <span className="text-xs tabular-nums text-pv-tinta-suave" aria-live="polite" aria-atomic="true">
                            {t("pagina", { actual: datos.pagina, total: datos.paginas })}
                        </span>
                        <button
                            type="button"
                            className={botonPagina}
                            aria-label={t("siguiente")}
                            aria-disabled={datos.pagina >= datos.paginas}
                            onClick={() => ir(1)}
                        >
                            <Icons.chevronRight className="size-4" aria-hidden />
                        </button>
                    </nav>
                )}
            </div>
        </section>
    );
}

/**
 * Historial de inicios de sesión: cuándo y desde dónde entró esta cuenta en los últimos 90 días,
 * de 10 en 10 con «Anterior · Página X de Y · Siguiente». Las filas y las páginas salen del
 * servidor (`/api/user/historial?pagina=N`, siempre de la persona de la cookie); aquí no se decide
 * nada, sólo se pinta y se pide la página.
 *
 * Vive aparte del resto de Mi cuenta: si la lista falla, sale su aviso y la página sigue.
 */
export function HistorialDeInicios() {
    const [e, enviar] = useReducer(reducir, estadoInicial);
    const cabecera = useRef<HTMLHeadingElement>(null);
    const moverFoco = useRef(false);

    useEffect(() => {
        const ctl = new AbortController();
        fetch(`/api/user/historial?pagina=${e.pedida}`, { cache: "no-store", signal: ctl.signal })
            .then((res) => {
                if (!res.ok) throw new Error(String(res.status));
                return res.json() as Promise<PaginaDeInicios>;
            })
            .then((datos) => enviar({ tipo: "llego", datos }))
            .catch(() => {
                if (!ctl.signal.aborted) enviar({ tipo: "fallo" });
            });
        return () => ctl.abort(); // otra página pedida antes de que llegue esta: la vieja ya no cuenta
    }, [e.pedida, e.intento]);

    // Al llegar la página nueva el foco (y con él el scroll) vuelve a la cabecera: quien pulsó
    // «Siguiente» abajo del todo no se queda mirando el final de una lista que ya cambió.
    useEffect(() => {
        if (!moverFoco.current || !e.datos) return;
        moverFoco.current = false;
        cabecera.current?.focus();
    }, [e.datos]);

    return (
        <ListaDeInicios
            datos={e.datos}
            cargando={e.cargando}
            error={e.error}
            pedida={e.pedida}
            refCabecera={cabecera}
            onPage={(pagina) => {
                moverFoco.current = true;
                enviar({ tipo: "pedir", pagina });
            }}
            onRetry={() => enviar({ tipo: "pedir", pagina: e.pedida })}
        />
    );
}
