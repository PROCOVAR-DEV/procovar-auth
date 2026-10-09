"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Icon } from "@iconify/react";
import { Button } from "@heroui/react";
import { describirAgente } from "@/lib/agente-de-usuario";
import type { FilaDeInicio, PaginaDeInicios } from "@/lib/historial-de-inicios";

const ICONO: Record<FilaDeInicio["tipo"], string> = {
    navegador: "lucide:globe",
    aparato: "lucide:tablet-smartphone",
};

/**
 * Historial de inicios de sesión: cuándo y desde dónde entró esta cuenta en los últimos 90 días.
 * Las filas salen del servidor (`/api/user/historial`, siempre de la persona de la cookie);
 * aquí no se decide nada, sólo se pinta y se pide la página siguiente.
 *
 * Vive aparte del resto de Mi cuenta: si la lista falla, sale su aviso y la página sigue.
 */
export function HistorialDeInicios() {
    const t = useTranslations("historial");
    const locale = useLocale();

    // `null` = todavía no hay respuesta; `false` = falló la primera página.
    const [filas, setFilas] = useState<FilaDeInicio[] | null | false>(null);
    const [siguiente, setSiguiente] = useState<string | null>(null);
    const [cargandoMas, setCargandoMas] = useState(false);
    const [falloMas, setFalloMas] = useState(false);

    const cargar = useCallback(async (desde: string | null) => {
        const url = desde ? `/api/user/historial?desde=${encodeURIComponent(desde)}` : "/api/user/historial";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as PaginaDeInicios;
    }, []);

    const primera = useCallback(async () => {
        setFilas(null);
        try {
            const pagina = await cargar(null);
            setFilas(pagina.filas);
            setSiguiente(pagina.siguiente);
        } catch {
            setFilas(false);
        }
    }, [cargar]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- trae la primera página al montar
        void primera();
    }, [primera]);

    async function verMas() {
        if (!siguiente || !Array.isArray(filas)) return;
        setCargandoMas(true);
        setFalloMas(false);
        try {
            const pagina = await cargar(siguiente);
            setFilas([...filas, ...pagina.filas]);
            setSiguiente(pagina.siguiente);
        } catch {
            setFalloMas(true);
        }
        setCargandoMas(false);
    }

    const cuando = (iso: string) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

    // El nombre se arma con las partes del agente para poder decir «en»/«on» en cada idioma.
    const nombre = (f: FilaDeInicio) => {
        const { navegador, sistema } = describirAgente(f.ua);
        if (f.tipo === "aparato") return sistema ? t("appEn", { sistema }) : t("app");
        if (navegador && sistema) return t("nombre", { navegador, sistema });
        return navegador ?? sistema ?? t("sinNombre");
    };

    return (
        <section aria-labelledby="historial-titulo" className="pv-ficha">
            <div className="pv-ficha-cabecera">
                <Icon icon="lucide:history" className="size-4 shrink-0 text-pv-tinta-suave" aria-hidden />
                <h2 id="historial-titulo" className="text-sm font-semibold">
                    {t("titulo")}
                </h2>
            </div>

            <div className="space-y-3 px-4 py-4">
                <p className="text-sm text-pv-tinta-suave">{t("ayuda")}</p>

                {filas === null && (
                    <p role="status" className="text-sm text-pv-tinta-suave">
                        {t("cargando")}
                    </p>
                )}

                {filas === false && (
                    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                        <div className="min-w-0 flex-1">
                            <p className="font-semibold">{t("error")}</p>
                            <p className="text-pv-tinta-suave">{t("errorPista")}</p>
                        </div>
                        <Button size="sm" variant="bordered" onPress={() => void primera()}>
                            {t("reintentar")}
                        </Button>
                    </div>
                )}

                {Array.isArray(filas) && filas.length === 0 && (
                    <p className="text-sm text-pv-tinta-suave">{t("vacio")}</p>
                )}

                {Array.isArray(filas) && filas.length > 0 && (
                    <ul aria-label={t("titulo")} className="divide-y divide-pv-trazo-tenue border-y border-pv-trazo-tenue">
                        {filas.map((f) => (
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
                )}

                {falloMas && (
                    <p role="alert" className="text-sm text-danger">
                        {t("errorMas")}
                    </p>
                )}

                {siguiente && Array.isArray(filas) && (
                    <Button variant="bordered" className="w-full sm:w-auto" isLoading={cargandoMas} onPress={() => void verMas()}>
                        {t("verMas")}
                    </Button>
                )}
            </div>
        </section>
    );
}
