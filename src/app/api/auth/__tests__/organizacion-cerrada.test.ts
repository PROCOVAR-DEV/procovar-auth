/**
 * `/api/auth/[...all]` corta los endpoints del plugin `organization` que cambian membresías sin
 * avisar (auditoría 08/10/2026), pero deja pasar el resto de better-auth y lo que la interfaz usa
 * (`set-active`) y las lecturas. Se ejecuta el handler REAL de la ruta con better-auth simulado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handler = vi.hoisted(() => vi.fn(async () => new Response('pasó', { status: 200 })));
vi.mock('@/lib/auth', () => ({ auth: { handler } }));

import { GET, POST } from '../[...all]/route';

const pet = (metodo: string, ruta: string) => new Request(`http://auth.test${ruta}`, { method: metodo });

beforeEach(() => handler.mockClear());

describe('POST a organization/** (mutaciones)', () => {
    it.each([
        'create', 'update', 'delete', 'remove-member', 'update-member-role', 'leave', 'accept-invitation',
        'reject-invitation', 'cancel-invitation', 'invite-member', 'add-member', 'create-role', 'delete-role',
        'update-role', 'create-team', 'remove-team', 'add-team-member', 'remove-team-member', 'check-slug',
        'inventado-en-una-version-futura',
    ])('%s → 404 y better-auth ni se entera', async (nombre) => {
        const res = await POST(pet('POST', `/api/auth/organization/${nombre}`));
        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });

    it.each([
        '/api/auth/organization/remove-member/',
        '/api/auth/organization//remove-member',
        '/api/auth/Organization/Remove-Member',
        '/api/auth/%6frganization/remove-member',
        '/api/auth/organization/set-active/../remove-member',
    ])('variante de escritura %s → 404', async (ruta) => {
        const res = await POST(pet('POST', ruta));
        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('lo que SÍ pasa', () => {
    it('POST organization/set-active (lo usa la interfaz)', async () => {
        const res = await POST(pet('POST', '/api/auth/organization/set-active'));
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledOnce();
    });
    it.each(['get-full-organization', 'list', 'list-members', 'get-active-member'])('GET organization/%s (lectura)', async (n) => {
        expect((await GET(pet('GET', `/api/auth/organization/${n}`))).status).toBe(200);
        expect(handler).toHaveBeenCalledOnce();
    });
    it.each([
        ['POST', '/api/auth/sign-in/email'], ['POST', '/api/auth/sign-out'], ['POST', '/api/auth/change-password'],
        ['POST', '/api/auth/reset-password'], ['GET', '/api/auth/get-session'],
        ['POST', '/api/auth/revoke-other-sessions'],
    ])('%s %s (nada que ver con organization)', async (m, ruta) => {
        const res = await (m === 'GET' ? GET : POST)(pet(m, ruta));
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledOnce();
    });
});
