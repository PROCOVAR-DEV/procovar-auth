/**
 * El hook `databaseHooks.session.create.after` de `auth.ts`, con better-auth DE VERDAD
 * (adaptador en memoria): abrir una sesión deja un `auth.signin.web`, sin token ni cookie, y
 * si apuntar falla se entra igual.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

const registro = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('@/lib/audit', () => registro);
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { auditarInicioWeb } from '../historial-de-inicios';

function nueva() {
    return betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: true },
        databaseHooks: { session: { create: { after: async (session) => auditarInicioWeb(session) } } },
    });
}

const CABECERAS = new Headers({
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36',
    'x-forwarded-for': '203.0.113.7',
});

beforeEach(() => {
    // También quita el «lanza» de la prueba anterior. Con llaves: lo que devuelve un beforeEach
    // se ejecuta como limpieza al acabar, y devolver el mock lo llamaría.
    registro.audit.mockReset();
});

describe('el inicio web deja huella', () => {
    it('al dar de alta y al volver a entrar: auth.signin.web con la persona, la IP, el agente y la sesión', async () => {
        const auth = nueva();
        const alta = await auth.api.signUpEmail({
            body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' },
            headers: CABECERAS,
        });
        await auth.api.signInEmail({
            body: { email: 'a@procovar.local', password: 'una-clave-larga-123' },
            headers: CABECERAS,
        });

        expect(registro.audit).toHaveBeenCalledTimes(2);
        const [primera, segunda] = registro.audit.mock.calls.map((c) => c[0]);
        for (const e of [primera, segunda]) {
            expect(e).toMatchObject({
                action: 'auth.signin.web',
                userId: alta.user.id,
                userAgent: expect.stringContaining('Chrome/131'),
                meta: { sessionId: expect.any(String) },
            });
        }
        expect(primera.meta.sessionId).not.toBe(segunda.meta.sessionId);
    });

    it('no guarda el token de la sesión ni la cookie', async () => {
        const auth = nueva();
        const alta = await auth.api.signUpEmail({
            body: { email: 'b@procovar.local', password: 'una-clave-larga-123', name: 'Beto' },
            headers: CABECERAS,
        });
        const guardado = JSON.stringify(registro.audit.mock.calls);
        expect(alta.token).toBeTruthy();
        expect(guardado).not.toContain(alta.token as string);
        expect(Object.keys(registro.audit.mock.calls[0][0].meta)).toEqual(['sessionId']);
    });

    it('un fallo de la auditoría NO rompe el inicio de sesión', async () => {
        const auth = nueva();
        registro.audit.mockImplementation(() => {
            throw new Error('la base de auditoría no contesta');
        });
        const alta = await auth.api.signUpEmail({
            body: { email: 'c@procovar.local', password: 'una-clave-larga-123', name: 'Cata' },
            headers: CABECERAS,
        });
        expect(alta.token).toBeTruthy();
        const entrada = await auth.api.signInEmail({
            body: { email: 'c@procovar.local', password: 'una-clave-larga-123' },
            headers: CABECERAS,
        });
        expect(entrada.token).toBeTruthy();
        expect(registro.audit).toHaveBeenCalledTimes(2);
    });

    it('un SSO silencioso (sin abrir sesión) no pasa por aquí: sin sesión nueva no hay apunte', async () => {
        const auth = nueva();
        const alta = await auth.api.signUpEmail({
            body: { email: 'd@procovar.local', password: 'una-clave-larga-123', name: 'Dani' },
            headers: CABECERAS,
        });
        registro.audit.mockClear();
        const cookie = `qb.session_token=${alta.token}`;
        await auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(registro.audit).not.toHaveBeenCalled();
    });
});

describe('auth.ts lo engancha', () => {
    const fuente = readFileSync(path.join(process.cwd(), 'src/lib/auth.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    it('en databaseHooks.session.create.after, y sólo ahí', () => {
        expect(fuente).toContain('after: async (session) => auditarInicioWeb(session)');
        expect(fuente.match(/auditarInicioWeb/g)).toHaveLength(2); // import + uso
    });
});
