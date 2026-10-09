/**
 * GET /api/notifications/panel?page=N — el panel de la campana (5 por página).
 *
 * El id de la persona sale SIEMPRE de la sesión (`requireSessionUserId`); la petición
 * solo trae el número de página. Notify filtra por destinatario, pero aquí además se
 * descarta cualquier fila que no sea de esta persona: es la última defensa si el
 * servicio de arriba se equivocara.
 *
 * Si Notify no contesta se responde 502, no una lista vacía: «No tienes avisos» y
 * «no se pueden cargar» son cosas distintas y el panel tiene que decir la verdad.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchInbox } from "@/lib/notify/inbox";
import { PANEL_FETCH_LIMIT, paginarAvisos, parsePagina } from "@/lib/notify/panel";
import type { InboxResponse } from "@/lib/notify/types";
import { normalizarFilas, vistaDeAviso } from "@/lib/notify/normalizar";
import { avisosNoDisponible, privada, requireSessionUserId } from "../_ownership";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const userId = await requireSessionUserId();
    if (userId instanceof NextResponse) return userId;

    const pagina = parsePagina(new URL(request.url).searchParams.get("page"));

    const inbox = await fetchInbox({ userId, limit: PANEL_FETCH_LIMIT });
    if (inbox.failed) {
        return avisosNoDisponible();
    }

    // Primero la forma segura (el payload es de otro servicio), luego la página, y al
    // navegador solo lo que se pinta.
    const suyos = normalizarFilas(inbox.data.filter((n) => n?.recipientUserId === userId));
    const { notifications, ...resto } = paginarAvisos(suyos, pagina);
    const body: InboxResponse = { ...resto, notifications: notifications.map(vistaDeAviso), nextCursor: null };
    return privada(NextResponse.json(body));
}
