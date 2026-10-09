/**
 * «Abrir el detalle es leerlo»: marca el aviso como leído UNA vez por id.
 *
 * Antes el efecto de la página hacía POST y luego `load()` sin mirar la respuesta: si el
 * POST fallaba y el GET contestaba, `readAt` seguía nulo, el aviso se recargaba, y el
 * efecto volvía a disparar sin pausa (un bucle de dos peticiones por vuelta). Aquí cada id
 * se intenta una sola vez (aunque falle) y solo se recarga si el POST dijo que sí. Puro: el
 * POST y la recarga se pasan por parámetro, para probarlo sin red ni DOM.
 */
export type ResultadoMarcaUnaVez = "marcado" | "fallo" | "omitido";

export async function marcarLeidoUnaVez(
    aviso: { id: string; readAt: string | null } | null,
    intentados: Set<string>,
    marcar: (id: string) => Promise<boolean>,
    recargar: () => Promise<void>,
): Promise<ResultadoMarcaUnaVez> {
    if (!aviso || aviso.readAt || intentados.has(aviso.id)) return "omitido";
    intentados.add(aviso.id);
    const ok = await marcar(aviso.id).catch(() => false);
    if (!ok) return "fallo";
    await recargar();
    return "marcado";
}
