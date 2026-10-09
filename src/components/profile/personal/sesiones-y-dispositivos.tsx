"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Icon } from "@iconify/react";
import { Button, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Panel } from "@/components/ui/panel";
import { authClient } from "@/lib/auth-client";
import {
    hayOtras,
    nombreDeFila,
    salirDeLaWeb,
    textosDelBoton,
    type FilaDeSesion,
    type Orden,
    type TipoDeSesion,
} from "@/lib/sesiones-de-la-persona";

const ICONO: Record<TipoDeSesion, string> = {
    navegador: "lucide:globe",
    aparato: "lucide:tablet-smartphone",
};

type Cierre = "otras" | "todas";

/** El cliente de better-auth sólo cierra la web; la salida real va por `sign-out`. Sólo se va a la entrada si salió. */
const salir = () => salirDeLaWeb(() => authClient.signOut(), () => window.location.assign("/"));

/**
 * Dispositivos y sesiones: dónde tiene la persona abierta su cuenta, con la actual marcada,
 * y cómo cerrarlas. Las filas y la autorización salen del servidor (`/api/user/sesiones`);
 * aquí no se decide nada, sólo se pinta y se pide.
 *
 * Vive aparte del resto de Mi cuenta: si la lista falla, sale su aviso y la página sigue.
 */
export function SesionesYDispositivos() {
    const t = useTranslations("dispositivos");
    const ta = useTranslations("dispositivosArreglos");
    const locale = useLocale();

    // `null` = todavía no hay respuesta; `false` = falló.
    const [filas, setFilas] = useState<FilaDeSesion[] | null | false>(null);
    const [truncada, setTruncada] = useState(false);
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [mensaje, setMensaje] = useState<{ texto: string; error: boolean } | null>(null);
    const [confirmando, setConfirmando] = useState<Cierre | null>(null);

    const cargar = useCallback(async () => {
        try {
            const res = await fetch("/api/user/sesiones", { cache: "no-store" });
            if (!res.ok) throw new Error(String(res.status));
            const cuerpo = (await res.json()) as { sesiones: FilaDeSesion[]; truncada?: boolean };
            setFilas(cuerpo.sesiones);
            setTruncada(cuerpo.truncada === true);
        } catch {
            setFilas(false);
        }
    }, []);

    useEffect(() => {
        void cargar();
    }, [cargar]);

    const cuando = (iso: string) =>
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

    async function salirOAvisar() {
        if (!(await salir())) setMensaje({ texto: t("resultado.falloAccion"), error: true });
    }

    async function ejecutar(orden: Orden, clave: string) {
        setOcupado(clave);
        setMensaje(null);
        try {
            const res = await fetch("/api/user/sesiones", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(orden),
            });
            if (res.status === 404) {
                setMensaje({ texto: t("resultado.noExiste"), error: true });
            } else if (!res.ok) {
                setMensaje({ texto: t("resultado.falloAccion"), error: true });
            } else if (orden.accion === "todas") {
                // La propia sesión también se acaba de cerrar: el servidor ya lo confirmó, así que se vuelve a la
                // entrada aunque `sign-out` ya no tenga sesión que cerrar (y conteste error).
                await authClient.signOut().catch(() => {});
                return window.location.assign("/");
            } else {
                setMensaje({
                    texto: t(orden.accion === "una" ? "resultado.una" : "resultado.otras"),
                    error: false,
                });
            }
        } catch {
            setMensaje({ texto: t("resultado.falloAccion"), error: true });
        }
        setOcupado(null);
        setConfirmando(null);
        await cargar(); // refleja el resultado sin recargar a mano
    }

    const lista = Array.isArray(filas) ? filas : [];
    const navegadores = lista.filter((f) => f.tipo === "navegador");
    const aparatos = lista.filter((f) => f.tipo === "aparato");
    const hayOtrasSesiones = hayOtras(lista);

    return (
        <section aria-labelledby="dispositivos-titulo" className="pv-ficha">
            <div className="pv-ficha-cabecera">
                <Icon icon="lucide:laptop-minimal" className="size-4 shrink-0 text-pv-tinta-suave" aria-hidden />
                <h2 id="dispositivos-titulo" className="text-sm font-semibold">
                    {t("titulo")}
                </h2>
            </div>

            <div className="space-y-3 px-4 py-4">
                <p className="text-sm text-pv-tinta-suave">{t("ayuda")}</p>

                {/* La única región «status»: la carga y el resultado de cerrar. Siempre está, para que se anuncie. */}
                <p role="status" className={mensaje && !mensaje.error ? "text-sm text-pv-visto" : "text-sm text-pv-tinta-suave"}>
                    {filas === null ? t("cargando") : mensaje && !mensaje.error ? mensaje.texto : null}
                </p>

                {filas === false && (
                    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                        <div className="min-w-0 flex-1">
                            <p className="font-semibold">{t("error")}</p>
                            <p className="text-pv-tinta-suave">{t("errorPista")}</p>
                        </div>
                        <Button size="sm" variant="bordered" onPress={() => void cargar()}>
                            {t("reintentar")}
                        </Button>
                    </div>
                )}

                {Array.isArray(filas) && filas.length === 0 && (
                    <p className="text-sm text-pv-tinta-suave">{t("vacio")}</p>
                )}

                {Array.isArray(filas) && filas.length > 0 && (
                    <>
                        <p className="text-sm font-semibold">
                            {t("conteo", { dispositivos: aparatos.length, navegadores: navegadores.length })}
                        </p>
                        {truncada && <p className="text-xs text-pv-tinta-suave">{ta("truncada")}</p>}
                        {[
                            { clave: "navegadores", filas: navegadores },
                            { clave: "dispositivos", filas: aparatos },
                        ].map(
                            (g) =>
                                g.filas.length > 0 && (
                                    <div key={g.clave}>
                                        <h3 className="pv-rotulo mb-1">{t(`grupo.${g.clave}`)}</h3>
                                        <ul className="divide-y divide-pv-trazo-tenue border-y border-pv-trazo-tenue">
                                            {g.filas.map((f) => {
                                                const nombre = nombreDeFila(f, t);
                                                const boton = textosDelBoton(f, t);
                                                return (
                                                <li key={f.id} className="flex flex-wrap items-start gap-3 py-3">
                                                    <Icon icon={ICONO[f.tipo]} className="mt-0.5 size-5 shrink-0 text-pv-azul" aria-hidden />
                                                    <div className="min-w-0 flex-1 basis-48">
                                                        <div className="flex flex-wrap items-center gap-1.5">
                                                            <span className="min-w-0 break-words text-sm font-semibold">{nombre}</span>
                                                            {f.actual && (
                                                                <span className="pv-etiqueta pv-etiqueta-visto">
                                                                    {t(f.tipo === "aparato" ? "esteDispositivo" : "estaSesion")}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <p className="mt-1 break-words text-xs text-pv-tinta-suave">
                                                            {f.ip ? t("ip", { ip: f.ip }) : t("sinIp")}
                                                            {" · "}
                                                            {t("ultimaActividad", { fecha: cuando(f.ultimaActividad) })}
                                                            {" · "}
                                                            {t("entroEl", { fecha: cuando(f.entroEl) })}
                                                        </p>
                                                        {f.tipo === "aparato" && (
                                                            <p className="mt-1 text-xs text-pv-tinta-suave">{t("aparatoAviso")}</p>
                                                        )}
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="bordered"
                                                        className="w-full sm:w-auto"
                                                        aria-label={boton.aria}
                                                        isLoading={ocupado === f.id}
                                                        isDisabled={ocupado !== null}
                                                        // La actual no se «revoca»: se sale (alcance web), que es lo que espera quien pulsa.
                                                        onPress={() => (f.actual ? void salirOAvisar() : void ejecutar({ accion: "una", id: f.id }, f.id))}
                                                    >
                                                        {boton.visible}
                                                    </Button>
                                                </li>
                                                );
                                            })}
                                        </ul>
                                    </div>
                                ),
                        )}
                    </>
                )}

                {mensaje?.error && (
                    <p role="alert" className="text-sm text-danger">
                        {mensaje.texto}
                    </p>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                        variant="bordered"
                        isDisabled={!hayOtrasSesiones || ocupado !== null}
                        onPress={() => setConfirmando("otras")}
                    >
                        {t("cerrarOtras")}
                    </Button>
                    <Button
                        color="danger"
                        variant="bordered"
                        isDisabled={ocupado !== null}
                        startContent={<Icon icon="lucide:power" className="size-4" aria-hidden />}
                        onPress={() => setConfirmando("todas")}
                    >
                        {t("cerrarTodas")}
                    </Button>
                </div>
            </div>

            <Panel
                isOpen={confirmando !== null}
                size="sm"
                backdrop="blur"
                onOpenChange={(abierto) => !abierto && ocupado === null && setConfirmando(null)}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader>
                                {t(confirmando === "todas" ? "confirmar.tituloTodas" : "confirmar.tituloOtras")}
                            </ModalHeader>
                            <ModalBody className="space-y-2 text-sm">
                                <p>{t(confirmando === "todas" ? "confirmar.cuerpoTodas" : "confirmar.cuerpoOtras")}</p>
                                {/* El teléfono y el escritorio también caen; el trabajo sin subir se queda. Sólo si hay alguno. */}
                                {aparatos.length > 0 && <p className="font-medium">{t("confirmar.avisoDispositivos")}</p>}
                            </ModalBody>
                            <ModalFooter className="flex-col gap-2 sm:flex-row">
                                <Button variant="bordered" className="w-full sm:w-auto" onPress={onClose} isDisabled={ocupado !== null}>
                                    {t("confirmar.cancelar")}
                                </Button>
                                <Button
                                    color="danger"
                                    className="w-full sm:w-auto"
                                    isLoading={ocupado === confirmando}
                                    isDisabled={ocupado !== null}
                                    onPress={() => confirmando && void ejecutar({ accion: confirmando }, confirmando)}
                                >
                                    {t(confirmando === "todas" ? "confirmar.confirmarTodas" : "confirmar.confirmarOtras")}
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Panel>
        </section>
    );
}
