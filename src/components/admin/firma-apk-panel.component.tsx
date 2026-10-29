"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Select, SelectItem } from "@heroui/react";
import { Icon } from "@iconify/react";

const ZONA = "America/Havana";

export interface FilaDeFirma {
    id: string;
    cuando: string;
    quien: string;
    app: string;
    paquete: string;
    version: string | null;
    sha256: string;
    tamano: number;
}

interface Certificado {
    sujeto: string;
    huella: string;
    validoDesde: string;
    validoHasta: string;
    importadaEl: string;
    esLaEsperada: boolean;
    /** Calculado en el servidor: pintar con `Date.now()` en el cliente daría un texto distinto al hidratar. */
    caducado: boolean;
}

const fecha = (iso: string) => new Date(iso).toLocaleDateString("es", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "numeric" });
const fechaHora = (iso: string) =>
    new Date(iso).toLocaleString("es", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** La huella en grupos de 8 para poder compararla a ojo con la de `apksigner`. */
const agrupada = (h: string) => h.match(/.{1,8}/g)?.join(" ") ?? h;

/**
 * La pantalla «Firma de las APK» (docs/firma-de-apk.md). La APK se manda tal cual al servidor (`POST /api/admin/firma-apk`) y
 * vuelve firmada: se ofrece como descarga aquí mismo. Nada de esto toca la clave: la pantalla solo sabe su huella.
 */
export function FirmaApkPanel({
    certificado, apps, filas, topeMb,
}: {
    certificado: Certificado | null;
    apps: { clientId: string; nombre: string; paquetes: string[] }[];
    filas: FilaDeFirma[];
    topeMb: number;
}) {
    const router = useRouter();
    const entrada = useRef<HTMLInputElement>(null);
    const [app, setApp] = useState<string>("");
    const [fichero, setFichero] = useState<File | null>(null);
    const [firmando, setFirmando] = useState(false);
    const [aviso, setAviso] = useState<string | null>(null);
    const [hecha, setHecha] = useState<{ url: string; nombre: string; sha256: string } | null>(null);

    async function firmar() {
        if (!app || !fichero) return;
        if (hecha) URL.revokeObjectURL(hecha.url);
        setHecha(null);
        setAviso(null);
        setFirmando(true);
        try {
            const r = await fetch("/api/admin/firma-apk", {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream", "X-Firma-App": app },
                body: fichero,
            });
            if (!r.ok) {
                const e = (await r.json().catch(() => ({}))) as { mensaje?: string };
                setAviso(e.mensaje ?? "No se pudo firmar. Vuelve a intentarlo.");
                return;
            }
            const nombre = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "apk-firmada.apk";
            setHecha({ url: URL.createObjectURL(await r.blob()), nombre, sha256: r.headers.get("X-Sha256") ?? "" });
            setFichero(null);
            if (entrada.current) entrada.current.value = "";
            router.refresh();
        } catch {
            setAviso("No se pudo firmar. Vuelve a intentarlo.");
        } finally {
            setFirmando(false);
        }
    }

    return (
        <>
            <div>
                <p className="pv-rotulo">Accesos</p>
                <h1 className="pv-titulo text-2xl">Firma de las APK</h1>
                <p className="mt-1 text-sm text-pv-tinta-suave">
                    La clave de firma de la casa vive cifrada dentro de Accesos y no sale nunca. Aquí se firman las APK con ella; Android deja
                    actualizar una aplicación solo si la firma es la misma de siempre.
                </p>
            </div>

            <div className="pv-ficha p-4">
                <h2 className="text-base font-semibold">Certificado de la casa</h2>
                {!certificado ? (
                    <p className="mt-2 text-sm text-pv-tinta">
                        Todavía no se ha importado la clave. Hay que importarla una vez (<code>scripts/importar-clave-de-firma.ts</code>, ver{" "}
                        <code>docs/firma-de-apk.md</code>); hasta entonces no se puede firmar.
                    </p>
                ) : (
                    <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                        <dt className="text-pv-tinta-suave">Sujeto</dt>
                        <dd className="break-words">{certificado.sujeto}</dd>
                        <dt className="text-pv-tinta-suave">Huella SHA-256</dt>
                        <dd>
                            <code className="break-all text-xs">{agrupada(certificado.huella)}</code>{" "}
                            <span className={`pv-etiqueta ${certificado.esLaEsperada ? "pv-etiqueta-visto" : "pv-etiqueta-cuno"}`}>
                                {certificado.esLaEsperada ? "Es la de siempre" : "NO es la esperada"}
                            </span>
                        </dd>
                        <dt className="text-pv-tinta-suave">Válido</dt>
                        <dd>
                            del {fecha(certificado.validoDesde)} al {fecha(certificado.validoHasta)}{" "}
                            {certificado.caducado && <span className="pv-etiqueta pv-etiqueta-cuno">Caducado</span>}
                        </dd>
                        <dt className="text-pv-tinta-suave">Importada</dt>
                        <dd>{fechaHora(certificado.importadaEl)}</dd>
                        <dt className="text-pv-tinta-suave">Aplicaciones que firma</dt>
                        <dd className="flex flex-col gap-0.5">
                            {apps.map((a) => (
                                <span key={a.clientId}>
                                    {a.nombre} <code className="text-xs text-pv-tinta-suave">{a.paquetes.join(", ")}</code>
                                </span>
                            ))}
                        </dd>
                    </dl>
                )}
            </div>

            <div className="pv-ficha p-4">
                <h2 className="text-base font-semibold">Firmar una APK</h2>
                <p className="mt-1 text-sm text-pv-tinta-suave">
                    Sube la APK sin firmar (o firmada con otra clave) y elige de qué aplicación es: el paquete que lleva por dentro tiene que ser el de
                    esa aplicación. Hasta {topeMb} MB. Se firma, se verifica que el certificado es el de la casa y solo entonces se entrega.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Select
                        label="Aplicación"
                        variant="bordered"
                        size="sm"
                        className="max-w-xs"
                        selectedKeys={app ? [app] : []}
                        onSelectionChange={(k) => setApp(String([...k][0] ?? ""))}
                        isDisabled={firmando}
                    >
                        {apps.map((a) => (
                            <SelectItem key={a.clientId}>{a.nombre}</SelectItem>
                        ))}
                    </Select>
                    <input
                        ref={entrada}
                        type="file"
                        accept=".apk,application/vnd.android.package-archive"
                        aria-label="APK que se va a firmar"
                        disabled={firmando}
                        onChange={(e) => setFichero(e.target.files?.[0] ?? null)}
                        className="text-sm"
                    />
                    <Button
                        color="primary"
                        isLoading={firmando}
                        isDisabled={!certificado || !app || !fichero}
                        onPress={firmar}
                        startContent={!firmando && <Icon icon="lucide:file-signature" className="size-4" aria-hidden />}
                    >
                        {firmando ? "Firmando…" : "Firmar APK"}
                    </Button>
                </div>
                {firmando && <p className="mt-2 text-sm text-pv-tinta-suave">Subiendo, firmando y verificando. Puede tardar un minuto.</p>}
                {aviso && <p role="alert" className="mt-2 text-sm text-pv-tinta">{aviso}</p>}
                {hecha && (
                    <div className="mt-3 flex flex-col gap-1 text-sm" role="status">
                        <span>
                            <span className="pv-etiqueta pv-etiqueta-visto">Firmada y verificada</span>
                        </span>
                        <a href={hecha.url} download={hecha.nombre} className="underline">
                            Descargar {hecha.nombre}
                        </a>
                        {hecha.sha256 && <code className="break-all text-xs text-pv-tinta-suave">SHA-256 {hecha.sha256}</code>}
                    </div>
                )}
            </div>

            <div className="pv-ficha overflow-x-auto">
                <h2 className="px-4 pt-4 text-base font-semibold">Historial de firmas</h2>
                {filas.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-pv-tinta-suave">Todavía no se ha firmado ninguna APK desde aquí.</div>
                ) : (
                    <table className="pv-tabla">
                        <thead>
                            <tr>
                                <th>Cuándo</th>
                                <th>Quién</th>
                                <th>Aplicación</th>
                                <th>Versión</th>
                                <th>Tamaño</th>
                                <th>SHA-256 de la firmada</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filas.map((f) => (
                                <tr key={f.id}>
                                    <td>{fechaHora(f.cuando)}</td>
                                    <td>{f.quien}</td>
                                    <td title={f.paquete}>{f.app}</td>
                                    <td>{f.version ?? <span className="text-pv-tinta-suave">—</span>}</td>
                                    <td>{mb(f.tamano)}</td>
                                    <td>
                                        <code className="text-xs" title={f.sha256}>{f.sha256.slice(0, 16)}…</code>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </>
    );
}
