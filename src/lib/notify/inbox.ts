/**
 * QB Notify v2 inbox client (HMAC-signed /v1 API).
 *
 * SERVER-ONLY. QB_NOTIFY_SECRET is an application-scoped key: whoever holds it can
 * read *any* user's inbox. It must never reach the browser — this module is
 * imported exclusively from route handlers under `src/app/api/notifications`,
 * never from a client component. (`src/lib/notify/types.ts` holds the shapes
 * the UI needs, and knows nothing about the key.)
 *
 * Signature contract (validated by qb-notify's internal/auth/hmac.go):
 *   stringToSign = METHOD \n PATH \n CANONICAL_QUERY \n SHA256_HEX(BODY) \n TIMESTAMP
 * carried in X-QBN-Key-Id / X-QBN-Timestamp / X-QBN-Signature.
 *
 * The inbox is a read model, not a business operation: this module NEVER throws
 * into the UI. On any failure it logs and returns empty/false, so a notify
 * outage degrades the bell to "no notifications" instead of breaking the page.
 */
import crypto from "crypto";
import { logger } from "@/lib/logger";
import type { InboxNotification } from "./types";

// Tripwire. The `server-only` package would fail the *build* instead, but qb-auth's
// pnpm store is pinned and regenerating the lockfile has broken the Dokploy build
// before — not worth it for a guard that is already belt-and-braces: Next never inlines
// a non-NEXT_PUBLIC_ env var into a client bundle, so QB_NOTIFY_SECRET cannot physically reach
// the browser. This just makes an accidental client import fail loudly instead of
// silently signing every request with `undefined`.
if (typeof window !== "undefined") {
    throw new Error("lib/notify/inbox.ts is server-only: it holds the QB Notify HMAC key.");
}

const BASE_URL = (process.env.QB_NOTIFY_URL ?? "").replace(/\/+$/, "");
const KEY_ID = process.env.QB_NOTIFY_KEY_ID ?? "";
const SECRET = process.env.QB_NOTIFY_SECRET ?? "";

const TIMEOUT_MS = 5_000;

export const inboxConfigured = (): boolean => Boolean(BASE_URL && KEY_ID && SECRET);

type Query = Record<string, string | number | boolean | undefined>;

/** Keys sorted, url-encoded; `""` when there is no query (matches Go's url.Values.Encode). */
const canonicalQuery = (query: Query): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === "") continue;
        params.append(key, String(value));
    }
    params.sort();
    return params.toString();
};

const signedHeaders = (method: string, path: string, query: string, body: string): HeadersInit => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    const stringToSign = [method.toUpperCase(), path, query, bodyHash, timestamp].join("\n");
    const signature = crypto.createHmac("sha256", SECRET).update(stringToSign, "utf8").digest("hex");
    return {
        "X-QBN-Key-Id": KEY_ID,
        "X-QBN-Timestamp": timestamp,
        "X-QBN-Signature": signature,
    };
};

const request = async <T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Query; body?: unknown } = {},
): Promise<T | null> => {
    if (!inboxConfigured()) {
        logger.warn("QB Notify inbox skipped: missing QB_NOTIFY_URL/QB_NOTIFY_KEY_ID/QB_NOTIFY_SECRET", { path });
        return null;
    }

    const query = canonicalQuery(options.query ?? {});
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const url = `${BASE_URL}${path}${query ? `?${query}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method,
            cache: "no-store",
            signal: controller.signal,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...signedHeaders(method, path, query, body),
            },
            ...(body ? { body } : {}),
        });

        if (!response.ok) {
            logger.error("QB Notify inbox responded with an error", {
                path,
                status: response.status,
                error: await response.text().catch(() => ""),
            });
            return null;
        }

        const text = await response.text();
        if (!text) return {} as T;
        return JSON.parse(text) as T;
    } catch (error) {
        logger.error("QB Notify inbox request failed", {
            path,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    } finally {
        clearTimeout(timer);
    }
};

export interface FetchInboxParams {
    /** ALWAYS the id of the authenticated session user — never a client-supplied value. */
    userId: string;
    limit?: number;
    cursor?: string | null;
    /** `SENT` = unread, `READ` = read. Omit for both. */
    status?: "SENT" | "READ";
    /** `true` returns archived notifications; the default excludes them. */
    archived?: boolean;
}

export interface InboxPage {
    data: InboxNotification[];
    nextCursor: string | null;
    /** El servicio no contestó (caído, sin configurar, firma mala). `data` vacío NO significa «sin avisos». */
    failed: boolean;
}

export const fetchInbox = async (params: FetchInboxParams): Promise<InboxPage> => {
    const result = await request<{ data?: InboxNotification[]; nextCursor?: string | null }>(
        "GET",
        "/v1/inbox",
        {
            query: {
                userId: params.userId,
                limit: params.limit,
                cursor: params.cursor ?? undefined,
                status: params.status,
                archived: params.archived ? "true" : undefined,
            },
        },
    );

    return {
        data: Array.isArray(result?.data) ? result.data : [],
        nextCursor: result?.nextCursor ?? null,
        failed: result === null,
    };
};

/**
 * Single notification, used to prove ownership before mutating it: the read /
 * archive endpoints are scoped by *application*, not by user, so without this
 * check any logged-in user could mark another user's notification read.
 */
export const fetchNotification = async (id: string): Promise<InboxNotification | null> => {
    const result = await request<InboxNotification & { data?: InboxNotification }>(
        "GET",
        `/v1/notifications/${encodeURIComponent(id)}`,
    );
    if (!result) return null;
    const view = result.data ?? result;
    return view?.id ? view : null;
};

const notificationAction = async (id: string, action: string): Promise<boolean> => {
    const result = await request<unknown>("POST", `/v1/notifications/${encodeURIComponent(id)}/${action}`);
    return result !== null;
};

export const markRead = (id: string) => notificationAction(id, "read");
export const archive = (id: string) => notificationAction(id, "archive");
export const unarchive = (id: string) => notificationAction(id, "unarchive");

/** Archives every already-read notification of this user. Bulk, so it takes the userId directly. */
export const archiveAllRead = async (userId: string): Promise<boolean> => {
    const result = await request<unknown>("POST", "/v1/inbox/archive-read", { query: { userId } });
    return result !== null;
};
