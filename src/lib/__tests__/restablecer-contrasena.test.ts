/**
 * M5 (auditoría 08/10/2026): restablecer la contraseña cierra TODAS las sesiones de la cuenta y avisa a
 * las aplicaciones («revocada», alcance todo). Con better-auth DE VERDAD (adaptador en memoria) y el
 * valor REAL de `revokeSessionsOnPasswordReset` que lleva `lib/auth.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const eventos = vi.hoisted(() => ({ publicarSesionCerrada: vi.fn(async () => {}) }));
vi.mock('@/lib/eventos-de-sesion', () => eventos);

import { cerrarSesionesAntes, cerrarSesionesDespues } from '@/lib/hooks-de-sesion';

const CLAVE = 'una-clave-larga-123';
const tokens: string[] = [];

async function mundo() {
    const { auth: real } = await import('@/lib/auth');
    const bd = { user: [], session: [], account: [], verification: [] };
    const auth = betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter(bd),
        emailAndPassword: {
            enabled: true,
            // La opción REAL de lib/auth.ts, no una copia.
            revokeSessionsOnPasswordReset: real.options.emailAndPassword?.revokeSessionsOnPasswordReset,
            sendResetPassword: async ({ token }) => { tokens.push(token); },
        },
        hooks: { before: cerrarSesionesAntes, after: cerrarSesionesDespues },
    });
    const alta = await auth.api.signUpEmail({ body: { email: 'a@procovar.local', password: CLAVE, name: 'Ana' } });
    // La sesión del ATACANTE, abierta antes de que la dueña recupere la cuenta.
    await auth.api.signInEmail({ body: { email: 'a@procovar.local', password: CLAVE } });
    await auth.api.requestPasswordReset({ body: { email: 'a@procovar.local', redirectTo: 'http://localhost:3500/x' } });
    return { auth, bd, userId: alta.user.id, token: tokens.at(-1)! };
}

beforeEach(() => { vi.clearAllMocks(); tokens.length = 0; });

describe('restablecer la contraseña', () => {
    it('lib/auth.ts lleva revokeSessionsOnPasswordReset: true y el cambio de contraseña del perfil revoca las demás', async () => {
        const { auth } = await import('@/lib/auth');
        expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
        const fuente = readFileSync(path.resolve(__dirname, '../../components/profile/personal/security-section.tsx'), 'utf8');
        expect(fuente).toMatch(/revokeOtherSessions:\s*true/);
        expect(fuente).not.toMatch(/revokeOtherSessions:\s*false/);
    });

    it('cierra todas las sesiones de la cuenta y publica «revocada» con el id de la persona', async () => {
        const { auth, bd, userId, token } = await mundo();
        expect((bd.session as unknown[]).length).toBeGreaterThan(0);
        await auth.api.resetPassword({ body: { newPassword: 'otra-clave-larga-456', token } });
        expect((bd.session as unknown[]).length).toBe(0);
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce();
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'revocada');
    });

    it('con un token inválido NO se publica nada y las sesiones siguen', async () => {
        const { auth, bd } = await mundo();
        const antes = (bd.session as unknown[]).length;
        await expect(auth.api.resetPassword({ body: { newPassword: 'otra-clave-larga-456', token: 'inventado' } })).rejects.toThrow();
        expect((bd.session as unknown[]).length).toBe(antes);
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
    });

    it('con la clave demasiado corta la llamada falla: no se publica y el token sigue valiendo', async () => {
        const { auth, bd, token } = await mundo();
        await expect(auth.api.resetPassword({ body: { newPassword: 'corta', token } })).rejects.toThrow();
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
        expect((bd.session as unknown[]).length).toBeGreaterThan(0);
    });

    it('por HTTP (el formulario del navegador) también publica', async () => {
        const { auth, userId, token } = await mundo();
        const res = await auth.handler(
            new Request('http://localhost:3500/api/auth/reset-password', {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: 'http://localhost:3500' },
                body: JSON.stringify({ newPassword: 'otra-clave-larga-456', token }),
            }),
        );
        expect(res.status).toBe(200);
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'revocada');
    });
});
