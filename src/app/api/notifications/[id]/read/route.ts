/** POST /api/notifications/{id}/read — ownership-checked before the upstream call. */
import { NextResponse } from "next/server";
import { markRead } from "@/lib/notify/inbox";
import { avisosNoDisponible, privada, requireOwnedNotification } from "../../_ownership";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const owned = await requireOwnedNotification(id);
    if (owned instanceof NextResponse) return owned;

    const ok = await markRead(id);
    return ok ? privada(NextResponse.json({ ok })) : avisosNoDisponible();
}
