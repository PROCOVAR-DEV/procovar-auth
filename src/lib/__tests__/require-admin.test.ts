import { describe, it, expect, vi, beforeEach } from 'vitest'

// require-admin.ts imports `auth` (heavy better-auth setup), `headers` from
// next/headers, `NextResponse` from next/server, and `isSessionRevoked`.
// Mock them all so we can exercise the revocation choke point in isolation.
vi.mock('../auth', () => ({
    auth: { api: { getSession: vi.fn() } },
}))
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => new Headers()),
}))
vi.mock('next/server', () => ({
    NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
}))
vi.mock('../session-revocation', () => ({
    isSessionRevoked: vi.fn(),
}))

import { resolveSessionUser } from '../require-admin'
import { auth } from '../auth'
import { isSessionRevoked } from '../session-revocation'

const mockGetSession = vi.mocked(auth.api.getSession)
const mockIsRevoked = vi.mocked(isSessionRevoked)

const SESSION = {
    user: { id: 'u1', email: 'a@b.c', isSystemAdmin: true },
    session: { id: 's1', expiresAt: new Date('2099-01-01T00:00:00Z') },
}

beforeEach(() => {
    vi.resetAllMocks()
})

describe('resolveSessionUser (revocation choke point)', () => {
    it('returns NULL when the underlying session is revoked', async () => {
        mockGetSession.mockResolvedValue(SESSION as any)
        mockIsRevoked.mockResolvedValue(true)
        await expect(resolveSessionUser()).resolves.toBeNull()
        expect(mockIsRevoked).toHaveBeenCalledWith('s1')
    })

    it('returns the user when the session is NOT revoked', async () => {
        mockGetSession.mockResolvedValue(SESSION as any)
        mockIsRevoked.mockResolvedValue(false)
        const resolved = await resolveSessionUser()
        expect(resolved?.user.id).toBe('u1')
        expect(resolved?.session.id).toBe('s1')
    })

    it('pide la sesión a la BASE, no a la caché de la cookie (una sesión cerrada no puede seguir valiendo)', async () => {
        mockGetSession.mockResolvedValue(SESSION as any)
        mockIsRevoked.mockResolvedValue(false)
        await resolveSessionUser()
        expect(mockGetSession).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }))
    })

    it('returns NULL when there is no session at all', async () => {
        mockGetSession.mockResolvedValue(null as any)
        await expect(resolveSessionUser()).resolves.toBeNull()
    })
})
