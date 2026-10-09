/**
 * GET /api/notifications?filter=unread|all|archived&limit=&cursor=
 *
 * The browser NEVER sends a userId: it is read from the session here. Anything
 * else would let a user page through someone else's inbox, because the upstream
 * `GET /v1/inbox?userId=` accepts any id under our application key.
 *
 * Notify caído = 502, nunca `200` con la lista vacía: «sin avisos» y «no se pueden cargar»
 * son cosas distintas. Y además de pedírselo a Notify por el id de la sesión, se descarta
 * toda fila que no sea de esta persona (defensa en profundidad, igual que el panel).
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchInbox } from "@/lib/notify/inbox";
import { normalizarFilas, vistaDeAviso } from "@/lib/notify/normalizar";
import { dropStaleHolds, isUnread, type InboxFilter, type InboxResponse } from "@/lib/notify/types";
import { avisosNoDisponible, privada, requireSessionUserId } from "./_ownership";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Wide enough to spot the confirm/cancel that supersedes a hold shown on this page. */
const CONTEXT_LIMIT = 100;

const parseFilter = (value: string | null): InboxFilter =>
    value === "unread" || value === "archived" ? value : "all";

export async function GET(request: NextRequest) {
    const userId = await requireSessionUserId();
    if (userId instanceof NextResponse) return userId;

    const { searchParams } = new URL(request.url);
    const filter = parseFilter(searchParams.get("filter"));
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const [page, context] = await Promise.all([
        fetchInbox({
            userId,
            limit,
            cursor,
            status: filter === "unread" ? "SENT" : undefined,
            archived: filter === "archived",
        }),
        // Also powers the badge, so it is fetched even when the page has no holds.
        fetchInbox({ userId, limit: CONTEXT_LIMIT }),
    ]);
    if (page.failed || context.failed) return avisosNoDisponible();

    const suyas = (rows: typeof page.data) =>
        normalizarFilas(rows.filter((n) => n?.recipientUserId === userId));
    const pageRows = suyas(page.data);
    const contextRows = suyas(context.data);

    // The archived tab must show *only* archived items; the other tabs already
    // exclude them upstream, but we don't rely on that.
    const scoped =
        filter === "archived"
            ? pageRows.filter((n) => n.archivedAt)
            : pageRows.filter((n) => !n.archivedAt);

    const body: InboxResponse = {
        notifications: dropStaleHolds(scoped, [...contextRows, ...pageRows]).map(vistaDeAviso),
        nextCursor: page.nextCursor,
        unreadCount: dropStaleHolds(contextRows).filter(isUnread).length,
    };

    return privada(NextResponse.json(body));
}
