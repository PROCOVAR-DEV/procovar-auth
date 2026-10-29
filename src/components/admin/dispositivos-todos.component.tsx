"use client";

import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import type { FilaDeAparato } from "@/lib/dispositivos-vista";
import type { Marca } from "@/lib/dispositivos";

const ZONA = "America/Havana";
function hace(iso: string | null): string {
    if (!iso) return "—";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return "ahora";
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86_400)} d`;
}
const completa = (iso: string) =>
    new Date(iso).toLocaleString("es", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

const CLASE: Record<Marca, string> = {
    funciona: "pv-etiqueta-visto",
    atascado: "pv-etiqueta-cuno",
    callado: "pv-etiqueta-gris",
    bloqueado: "pv-etiqueta-cuno",
    sin_estado: "pv-etiqueta-azul",
};
const TEXTO: Record<Marca, string> = { funciona: "funciona", atascado: "atascado", callado: "callado", bloqueado: "bloqueado", sin_estado: "sin estado" };

/** La pestaña «Todos»: cada aparato UNA vez; una etiqueta por aplicación en la que está (clic = su pestaña, donde se bloquea y se ve la actividad). */
export function DispositivosTodos({
    pestanas, todos, filas, truncada, tope,
}: {
    pestanas: { clientId: string; nombre: string }[];
    todos: string;
    filas: FilaDeAparato[];
    truncada: boolean;
    tope: number;
}) {
    const router = useRouter();
    const ir = (app: string) => router.push(`/dashboard/dispositivos?app=${encodeURIComponent(app)}`);

    return (
        <>
            <div>
                <p className="pv-rotulo">Accesos</p>
                <h1 className="pv-titulo text-2xl">Dispositivos</h1>
                <p className="mt-1 text-sm text-pv-tinta-suave">
                    Cada aparato una sola vez, con una etiqueta por cada aplicación en la que está. Pulsa una etiqueta para ver ese aparato en su aplicación.
                </p>
            </div>

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Aplicaciones">
                {pestanas.map((t) => (
                    <Button key={t.clientId} role="tab" aria-selected={t.clientId === todos} size="sm" variant={t.clientId === todos ? "solid" : "bordered"} onPress={() => ir(t.clientId)}>
                        {t.nombre}
                    </Button>
                ))}
            </div>

            {truncada && <p className="text-sm text-pv-tinta">Se ven los {tope} más recientes: hay más.</p>}

            <div className="pv-ficha overflow-x-auto">
                {filas.length === 0 ? (
                    <div className="px-4 py-14 text-center text-sm text-pv-tinta-suave">Todavía no hay ningún aparato registrado.</div>
                ) : (
                    <table className="pv-tabla">
                        <thead>
                            <tr>
                                <th>Aparato</th>
                                <th>Aplicaciones</th>
                                <th>Cuentas</th>
                                <th>Visto</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filas.map((f) => (
                                <tr key={f.id}>
                                    <td>
                                        <div className="leading-tight">
                                            <div>{f.nombre ?? <span className="text-pv-tinta-suave">Sin nombre</span>}</div>
                                            <div className="text-xs text-pv-tinta-suave">{f.plataforma ?? "Sin identificar"}</div>
                                        </div>
                                    </td>
                                    <td>
                                        <div className="flex flex-wrap gap-1">
                                            {f.apps.map((a) => (
                                                <button
                                                    key={a.clientId}
                                                    type="button"
                                                    onClick={() => ir(a.clientId)}
                                                    className={`pv-etiqueta ${CLASE[a.marca]} cursor-pointer`}
                                                    title={`${a.nombre}${a.version ? ` · versión ${a.version}` : ""}${a.sucursal ? ` · ${a.sucursal}` : ""} · ${TEXTO[a.marca]} · visto ${completa(a.vistoAt)}`}
                                                >
                                                    {a.nombre}{a.version ? ` ${a.version}` : ""} · {TEXTO[a.marca]}
                                                </button>
                                            ))}
                                        </div>
                                    </td>
                                    <td>
                                        <div className="flex flex-col gap-0.5 leading-tight">
                                            {f.cuentas.slice(0, 5).map((c) => (
                                                <div key={c.persona} className="text-sm" title={`Última vez en ${c.app}: ${completa(c.vistoAt)}`}>
                                                    {c.persona} <span className="text-xs text-pv-tinta-suave">· {c.app} · {hace(c.vistoAt)}</span>
                                                </div>
                                            ))}
                                            {f.cuentas.length > 5 && <div className="text-xs text-pv-tinta-suave">y {f.cuentas.length - 5} más</div>}
                                        </div>
                                    </td>
                                    <td className="whitespace-nowrap" title={completa(f.vistoAt)}>{hace(f.vistoAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </>
    );
}
