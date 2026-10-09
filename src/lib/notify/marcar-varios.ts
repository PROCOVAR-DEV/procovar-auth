/**
 * «Marcar todo como leído» del centro de avisos.
 *
 * Notify no tiene una operación en bloque para marcar leídas (solo `archive-read`), así
 * que se marca de una en una. Dos topes para no hacer un reguero de peticiones: como
 * mucho `MARCAR_MAX` avisos por pulsación y `EN_PARALELO` a la vez (cada marca cuesta
 * dos llamadas a Notify: comprobar el dueño y marcar). Puro: la llamada real se pasa
 * por parámetro, para probarlo sin red.
 */
export const MARCAR_MAX = 50;
export const EN_PARALELO = 5;

export interface ResultadoMarcar {
    hechos: number;
    fallidos: number;
}

export async function marcarVarios(
    ids: string[],
    marcar: (id: string) => Promise<boolean>,
    maximo: number = MARCAR_MAX,
): Promise<ResultadoMarcar> {
    const lote = ids.slice(0, maximo);
    let hechos = 0;
    for (let i = 0; i < lote.length; i += EN_PARALELO) {
        const tanda = await Promise.all(lote.slice(i, i + EN_PARALELO).map((id) => marcar(id).catch(() => false)));
        hechos += tanda.filter(Boolean).length;
    }
    return { hechos, fallidos: lote.length - hechos };
}
