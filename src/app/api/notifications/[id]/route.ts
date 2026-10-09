/** GET /api/notifications/{id} — one notification, only if it is the session user's. */
import { NextResponse } from "next/server";
import { normalizarFila, vistaDeAviso } from "@/lib/notify/normalizar";
import { privada, requireOwnedNotification } from "../_ownership";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const owned = await requireOwnedNotification(id);
    if (owned instanceof NextResponse) return owned;

    const fila = normalizarFila(owned);
    return privada(NextResponse.json({ notification: fila ? vistaDeAviso(fila) : null }));
}
