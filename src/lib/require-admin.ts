/**
 * Helper to enforce a logged-in System Admin user.
 * Usage in admin route handlers:
 *   const guard = await requireSystemAdmin();
 *   if (guard instanceof NextResponse) return guard;
 *   // ... use guard.user
 */
import { NextResponse } from 'next/server';
import { auth } from './auth';
import { headers } from 'next/headers';
import { isSessionRevoked } from './session-revocation';

type SessionUser = {
    id: string;
    email: string;
    isSystemAdmin?: boolean;
};

export async function resolveSessionUser() {
    // `disableCookieCache`: a la base, no a la caché de la cookie (que no sabe de sesiones cerradas).
    const session = await auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
    if (!session || !session.user) return null;

    // Reject revoked sessions. getSession() serves from its cookie cache and
    // ignores our `revokedAt` column, so this DB check is what actually enforces
    // revocation for /api/admin/* (requireSystemAdmin) and every other caller of
    // resolveSessionUser (incl. the dashboard's getCurrentUser fast path).
    if (await isSessionRevoked(session.session?.id)) return null;

    const user = session.user as SessionUser;
    return {
        user,
        session: {
            id: session.session?.id || '',
            userId: user.id,
            expiresAt: session.session?.expiresAt || new Date(),
        },
    };
}

export async function requireSystemAdmin() {
    const resolved = await resolveSessionUser();
    if (!resolved) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const { user, session } = resolved;
    if (!user.isSystemAdmin) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    return { user, session };
}
