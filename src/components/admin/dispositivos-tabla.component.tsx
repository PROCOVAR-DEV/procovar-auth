"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Select, SelectItem } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { FilaDeDispositivo } from "@/lib/dispositivos-vista";
import type { Marca } from "@/lib/dispositivos";

const ZONA = "America/Havana";

/** «hace 5 min», «hace 3 h», «hace 2 d», y la fecha entera al pasar el ratón. */
function hace(iso: string | null): string {
    if (!iso) return "—";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return "ahora";
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86_400)} d`;
}
const completa = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("es", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

const MARCA: Record<Marca, { texto: string; clase: string; explicacion: string }> = {
    funciona: { texto: "Funciona", clase: "pv-etiqueta-visto", explicacion: "Se ve hace poco, no tiene nada pendiente ni rechazado." },
    atascado: { texto: "Atascado", clase: "pv-etiqueta-cuno", explicacion: "Tiene rechazados, o pendientes sin subir desde hace horas, o un error reciente." },
    callado: { texto: "Callado", clase: "pv-etiqueta-gris", explicacion: "No se ve desde hace dos días o más." },
    bloqueado: { texto: "Bloqueado", clase: "pv-etiqueta-cuno", explicacion: "Un administrador lo bloqueó: no puede entrar." },
    sin_estado: { texto: "Sin estado", clase: "pv-etiqueta-azul", explicacion: "Se ve, pero la aplicación aún no cuenta cómo le va." },
};

export function DispositivosTabla({
    pestanas, app, sucursal, sucursales, filas, truncada, tope,
}: {
    pestanas: { clientId: string; nombre: string }[];
    app: string;
    sucursal: string;
    sucursales: string[];
    filas: FilaDeDispositivo[];
    truncada: boolean;
    tope: number;
}) {
    const router = useRouter();
    const params = useSearchParams();
    const [editando, setEditando] = useState<string | null>(null);
    const [nombre, setNombre] = useState("");
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [aviso, setAviso] = useState<string | null>(null);

    const ir = (cambios: Record<string, string>) => {
        const p = new URLSearchParams(params.toString());
        for (const [k, v] of Object.entries(cambios)) {
            if (v) p.set(k, v);
            else p.delete(k);
        }
        router.push(`/dashboard/dispositivos?${p.toString()}`);
    };

    async function hacer(f: FilaDeDispositivo, cuerpo: object, confirmar?: string) {
        if (confirmar && !window.confirm(confirmar)) return;
        setOcupado(f.id);
        setAviso(null);
        try {
            const r = await fetch(`/api/admin/dispositivos/${encodeURIComponent(f.id)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cuerpo),
            });
            if (!r.ok) {
                const e = (await r.json().catch(() => ({}))) as { error?: string };
                setAviso(
                    e.error === "sin_sesion_que_cerrar"
                        ? "Ese aparato no tiene una sesión que cerrar (aún no ha renovado con su identificación)."
                        : "No se pudo hacer. Vuelve a intentarlo.",
                );
            }
            setEditando(null);
            router.refresh();
        } finally {
            setOcupado(null);
        }
    }

    const por = { funciona: 0, atascado: 0, callado: 0, bloqueado: 0, sin_estado: 0 } as Record<Marca, number>;
    for (const f of filas) por[f.marca]++;

    return (
        <>
            <div>
                <p className="pv-rotulo">Accesos</p>
                <h1 className="pv-titulo text-2xl">Dispositivos</h1>
                <p className="mt-1 text-sm text-pv-tinta-suave">
                    Los aparatos de cada aplicación: de quién son, qué versión tienen, cuándo trabajaron y si funcionan. Lo que hicieron, aplicación por aplicación,
                    está en «Ver actividad».
                </p>
            </div>

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Aplicaciones">
                {pestanas.map((t) => (
                    <Button
                        key={t.clientId}
                        role="tab"
                        aria-selected={t.clientId === app}
                        size="sm"
                        variant={t.clientId === app ? "solid" : "bordered"}
                        onPress={() => ir({ app: t.clientId, sucursal: "" })}
                    >
                        {t.nombre}
                    </Button>
                ))}
            </div>

            <div className="flex flex-wrap items-end gap-3">
                <Select
                    label="Sucursal"
                    variant="bordered"
                    size="sm"
                    className="max-w-xs"
                    selectedKeys={sucursal ? [sucursal] : []}
                    onSelectionChange={(k) => ir({ sucursal: String([...k][0] ?? "") })}
                >
                    {sucursales.map((s) => (
                        <SelectItem key={s}>{s}</SelectItem>
                    ))}
                </Select>
                {sucursal && (
                    <Button size="sm" variant="light" onPress={() => ir({ sucursal: "" })} startContent={<Icon icon="lucide:x" className="size-4" aria-hidden />}>
                        Quitar el filtro
                    </Button>
                )}
                <div className="ml-auto flex flex-wrap gap-2 text-sm">
                    {(Object.keys(MARCA) as Marca[]).filter((m) => por[m] > 0).map((m) => (
                        <span key={m} className={`pv-etiqueta ${MARCA[m].clase}`} title={MARCA[m].explicacion}>
                            {por[m]} {MARCA[m].texto.toLowerCase()}
                        </span>
                    ))}
                </div>
            </div>

            {aviso && <p role="alert" className="text-sm text-pv-tinta">{aviso}</p>}
            {truncada && <p className="text-sm text-pv-tinta">Se ven los {tope} más recientes: hay más. Filtra por sucursal para ver el resto.</p>}

            <div className="pv-ficha overflow-x-auto">
                {filas.length === 0 ? (
                    <div className="px-4 py-14 text-center text-sm text-pv-tinta-suave">
                        Todavía no hay ningún aparato de esta aplicación. Aparecen cuando la aplicación manda su identificación al renovar la sesión
                        (<code>X-Aparato-Id</code>, ver <code>docs/dispositivos.md</code>).
                    </div>
                ) : (
                    <table className="pv-tabla">
                        <thead>
                            <tr>
                                <th>Estado</th>
                                <th>Persona</th>
                                <th>Aparato</th>
                                <th>Visto</th>
                                <th>Descarga / subida</th>
                                <th>Trabajo</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filas.map((f) => (
                                <tr key={f.id}>
                                    <td>
                                        <span className={`pv-etiqueta ${MARCA[f.marca].clase}`} title={MARCA[f.marca].explicacion}>
                                            {MARCA[f.marca].texto}
                                        </span>
                                    </td>
                                    <td>
                                        <div className="leading-tight">
                                            <div>{f.persona}</div>
                                            {f.sucursal && <div className="text-xs text-pv-tinta-suave">{f.sucursal}</div>}
                                        </div>
                                    </td>
                                    <td>
                                        {editando === f.id ? (
                                            <div className="flex items-center gap-1">
                                                <Input size="sm" variant="bordered" aria-label="Nombre del aparato" value={nombre} onValueChange={setNombre} maxLength={80} className="min-w-40" />
                                                <Button size="sm" isIconOnly variant="light" aria-label="Guardar el nombre" isDisabled={ocupado === f.id} onPress={() => hacer(f, { accion: "nombre", nombre: nombre.trim() || null })}>
                                                    <Icon icon="lucide:check" className="size-4" aria-hidden />
                                                </Button>
                                                <Button size="sm" isIconOnly variant="light" aria-label="Cancelar" onPress={() => setEditando(null)}>
                                                    <Icon icon="lucide:x" className="size-4" aria-hidden />
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="leading-tight">
                                                <div>{f.nombre ?? <span className="text-pv-tinta-suave">Sin nombre</span>}</div>
                                                <div className="text-xs text-pv-tinta-suave">
                                                    {[f.plataforma, f.version ? `versión ${f.version}` : null].filter(Boolean).join(" · ") || "Sin identificar"}
                                                </div>
                                            </div>
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap" title={completa(f.vistoAt)}>{hace(f.vistoAt)}</td>
                                    <td className="whitespace-nowrap text-xs">
                                        <div title={completa(f.ultimaDescarga)}>Descarga: {hace(f.ultimaDescarga)}</div>
                                        <div title={completa(f.ultimaSubida)}>Subida: {hace(f.ultimaSubida)}</div>
                                    </td>
                                    <td className="text-xs">
                                        {f.pendientes === null && f.rechazados === null && !f.ultimoError ? (
                                            <span className="text-pv-tinta-suave">No informa</span>
                                        ) : (
                                            <div className="leading-tight">
                                                <div>{f.pendientes ?? "—"} pendientes · {f.rechazados ?? "—"} rechazados</div>
                                                {f.ultimoError && <div className="text-pv-tinta" title={f.ultimoError}>Error: {f.ultimoError.slice(0, 60)}</div>}
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        <div className="flex flex-wrap gap-1">
                                            {f.actividadUrl && (
                                                <Button as="a" href={f.actividadUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="light" startContent={<Icon icon="lucide:activity" className="size-4" aria-hidden />}>
                                                    Ver actividad
                                                </Button>
                                            )}
                                            <Button size="sm" variant="light" isDisabled={ocupado === f.id} onPress={() => { setNombre(f.nombrePuesto ?? ""); setEditando(f.id); }} startContent={<Icon icon="lucide:pencil" className="size-4" aria-hidden />}>
                                                Nombre
                                            </Button>
                                            <Button size="sm" variant="light" isDisabled={ocupado === f.id} onPress={() => hacer(f, { accion: "cerrar" }, "¿Cerrar la sesión de este aparato? Podrá volver a entrar.")} startContent={<Icon icon="lucide:log-out" className="size-4" aria-hidden />}>
                                                Cerrar sesión
                                            </Button>
                                            {f.bloqueado ? (
                                                <Button size="sm" variant="light" isDisabled={ocupado === f.id} onPress={() => hacer(f, { accion: "desbloquear" })} startContent={<Icon icon="lucide:lock-open" className="size-4" aria-hidden />}>
                                                    Desbloquear
                                                </Button>
                                            ) : (
                                                <Button size="sm" color="danger" variant="light" isDisabled={ocupado === f.id} onPress={() => hacer(f, { accion: "bloquear" }, "¿Bloquear este aparato? Se le cierra la sesión y no podrá volver a entrar hasta que lo desbloquees.")} startContent={<Icon icon="lucide:ban" className="size-4" aria-hidden />}>
                                                    Bloquear
                                                </Button>
                                            )}
                                        </div>
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
