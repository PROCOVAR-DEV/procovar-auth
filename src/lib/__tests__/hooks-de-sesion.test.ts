/**
 * Cerrar sesión desde better-auth avisa a las aplicaciones — con better-auth DE VERDAD
 * (adaptador en memoria), no con un `ctx` inventado: lo que hay que demostrar es que
 * el par antes/después comparte la llamada y que el aviso sale por TODAS las vías
 * (`auth.api.signOut` del servidor, que es lo que usan logout-fanout, la acción de
 * `(base)/logout` y `auth.server`, y el endpoint HTTP que usa el botón del navegador).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

const eventos = vi.hoisted(() => ({ publicarSesionCerrada: vi.fn(async () => {}) }));
vi.mock('@/lib/eventos-de-sesion', () => eventos);
// `/revoke-session` clasifica la sesión por su refresh ligado: aquí, las sesiones cuyo id esté en `refrescos`.
const refrescos = vi.hoisted(() => new Set<string>());
const prismaFalso = vi.hoisted(() => ({
    refreshToken: { findFirst: vi.fn(async (a: { where: { sessionId: string } }) => (refrescos.has(a.where.sessionId) ? { id: 'r' } : null)) },
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaFalso }));
const registro = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/logger', () => registro);
vi.mock('@/lib/historial-de-inicios', () => ({ auditarInicioWeb: vi.fn(async () => {}) }));

import { cerrarSesionesAntes, cerrarSesionesDespues } from '@/lib/hooks-de-sesion';

function nueva() {
    return betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        emailAndPassword: { enabled: true },
        hooks: { before: cerrarSesionesAntes, after: cerrarSesionesDespues },
    });
}

/** Da de alta a alguien y devuelve la cabecera Cookie de su sesión y su id. */
async function conSesion(auth: ReturnType<typeof nueva>, email = 'a@procovar.local') {
    const r = await auth.api.signUpEmail({
        body: { email, password: 'una-clave-larga-123', name: 'Ana' },
        returnHeaders: true,
    });
    const cookie = (r.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');
    return { cookie, userId: r.response.user.id };
}

beforeEach(() => {
    vi.clearAllMocks();
    refrescos.clear();
});

describe('better-auth → sesion-cerrada', () => {
    it('sign-out por la API del servidor publica «logout» con el id de QUIEN salió', async () => {
        const auth = nueva();
        const { cookie, userId } = await conSesion(auth);
        await auth.api.signOut({ headers: new Headers({ cookie }) });
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce();
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'logout');
    });

    it('sign-out por HTTP (lo que hace authClient.signOut en el navegador) también publica', async () => {
        const auth = nueva();
        const { cookie, userId } = await conSesion(auth);
        const res = await auth.handler(
            new Request('http://localhost:3500/api/auth/sign-out', {
                method: 'POST',
                headers: { cookie, origin: 'http://localhost:3500', 'content-type': 'application/json' },
                body: '{}',
            }),
        );
        expect(res.status).toBe(200);
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'logout');
    });

    it('revoke-other-sessions publica «revocada»', async () => {
        const auth = nueva();
        const { cookie, userId } = await conSesion(auth);
        await auth.api.revokeOtherSessions({ headers: new Headers({ cookie }) });
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'revocada');
    });

    it('sign-out sin sesión (cookie ausente) no publica nada', async () => {
        const auth = nueva();
        await auth.api.signOut({ headers: new Headers() }).catch(() => {});
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
    });

    it('si la llamada FALLA no se publica (cookie corrupta → sin sesión)', async () => {
        const auth = nueva();
        const { userId } = await conSesion(auth);
        void userId;
        await auth.api
            .revokeOtherSessions({ headers: new Headers({ cookie: 'better-auth.session_token=falsa.firma' }) })
            .catch(() => {});
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
    });

    it('change-password con revokeOtherSessions publica «revocada»; sin ello, no', async () => {
        const auth = nueva();
        const { cookie, userId } = await conSesion(auth);
        const cuerpo = { currentPassword: 'una-clave-larga-123', newPassword: 'otra-clave-larga-456' };
        await auth.api.changePassword({ headers: new Headers({ cookie }), body: { ...cuerpo, revokeOtherSessions: false } });
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
        await auth.api.changePassword({
            headers: new Headers({ cookie }),
            body: { currentPassword: cuerpo.newPassword, newPassword: 'una-tercera-clave-789', revokeOtherSessions: true },
        });
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'revocada');
    });

    it('si la llamada FALLA con la sesión bien resuelta (clave actual equivocada) tampoco se publica', async () => {
        const auth = nueva();
        const { cookie } = await conSesion(auth);
        await expect(
            auth.api.changePassword({
                headers: new Headers({ cookie }),
                body: { currentPassword: 'no-es-esta', newPassword: 'otra-clave-larga-456', revokeOtherSessions: true },
            }),
        ).rejects.toThrow();
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
    });

    it('otras rutas (iniciar sesión, obtener sesión) no publican', async () => {
        const auth = nueva();
        const { cookie } = await conSesion(auth);
        await auth.api.getSession({ headers: new Headers({ cookie }) });
        await auth.api.signInEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123' } });
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled();
    });
});

describe('el `auth` de la aplicación lleva los hooks puestos', () => {
    it('hooks.before/after de lib/auth.ts son los que avisan (sin esto nada de lo de arriba sale en producción)', async () => {
        const { auth } = await import('@/lib/auth');
        expect(auth.options.hooks?.before).toBe(cerrarSesionesAntes);
        expect(auth.options.hooks?.after).toBe(cerrarSesionesDespues);
    });
});

/**
 * `/revoke-session` cierra UNA sesión: el alcance del aviso depende de CUÁL (antes publicaba
 * `todo` siempre, y cerrar un navegador echaba al teléfono).
 */
describe('revoke-session: el aviso depende de la clase de sesión', () => {
    function mundo() {
        const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
        const auth = betterAuth({
            baseURL: 'http://localhost:3500',
            secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
            database: memoryAdapter(db),
            emailAndPassword: { enabled: true },
            session: { additionalFields: { clientId: { type: 'string', required: false } } },
            hooks: { before: cerrarSesionesAntes, after: cerrarSesionesDespues },
        })
        return { auth, db }
    }
    const cookieDe = (h: Headers) => (h.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    async function alta(auth: ReturnType<typeof mundo>['auth'], email: string) {
        const r = await auth.api.signUpEmail({ body: { email, password: 'una-clave-larga-123', name: email }, returnHeaders: true })
        return { userId: r.response.user.id, cookie: cookieDe(r.headers) }
    }
    /** `clientId`: lo que lleva la fila. `conRefresh`: lo que la hace aparato (un refresh ligado, como en /api/auth/token). */
    async function segunda(m: ReturnType<typeof mundo>, email: string, o: { clientId?: string; conRefresh?: boolean } = {}) {
        const r = await m.auth.api.signInEmail({ body: { email, password: 'una-clave-larga-123' } })
        const fila = m.db.session.find((s) => s.token === r.token)!
        if (o.clientId) fila.clientId = o.clientId
        if (o.conRefresh) refrescos.add(fila.id as string)
        return r.token
    }

    it('una sesión WEB: avisa con alcance web («logout»)', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        const token = await segunda(m, 'a@procovar.local')
        await m.auth.api.revokeSession({ headers: new Headers({ cookie: ana.cookie }), body: { token } })
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce()
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([ana.userId], 'logout')
    })

    it('la sesión de un APARATO (refresh ligado): no avisa de nada', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        const token = await segunda(m, 'a@procovar.local', { clientId: 'delivery-apk', conRefresh: true })
        await m.auth.api.revokeSession({ headers: new Headers({ cookie: ana.cookie }), body: { token } })
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
    })

    it('una sesión WEB con clientId «delivery-apk» pero SIN refresh (cookie falsa) avisa como web («logout»)', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        const token = await segunda(m, 'a@procovar.local', { clientId: 'delivery-apk' })
        await m.auth.api.revokeSession({ headers: new Headers({ cookie: ana.cookie }), body: { token } })
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce()
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([ana.userId], 'logout')
    })

    it('si no se puede clasificar la sesión (la base falla): no se avisa, pero queda un warn SIN datos personales', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        const token = await segunda(m, 'a@procovar.local')
        prismaFalso.refreshToken.findFirst.mockRejectedValueOnce(Object.assign(new Error(`falló con ${token} y ana@procovar.local`), { code: 'P1001' }))
        await m.auth.api.revokeSession({ headers: new Headers({ cookie: ana.cookie }), body: { token } })
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
        expect(registro.logger.warn).toHaveBeenCalledOnce()
        const texto = JSON.stringify(registro.logger.warn.mock.calls[0])
        expect(texto).toContain('P1001')
        expect(texto).not.toContain(token)
        expect(texto).not.toContain('ana@procovar.local')
    })

    it('un token AJENO: better-auth no hace nada y tampoco se avisa', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        await alta(m.auth, 'b@procovar.local')
        const deBeto = m.db.session.find((s) => s.userId !== ana.userId)!.token as string
        await m.auth.api.revokeSession({ headers: new Headers({ cookie: ana.cookie }), body: { token: deBeto } })
        expect(m.db.session).toHaveLength(2)
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
    })

    it('revoke-sessions y revoke-other-sessions siguen siendo «revocada» (todo)', async () => {
        const m = mundo()
        const ana = await alta(m.auth, 'a@procovar.local')
        await m.auth.api.revokeOtherSessions({ headers: new Headers({ cookie: ana.cookie }) })
        expect(eventos.publicarSesionCerrada).toHaveBeenLastCalledWith([ana.userId], 'revocada')
        await m.auth.api.revokeSessions({ headers: new Headers({ cookie: ana.cookie }) })
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledTimes(2)
        expect(eventos.publicarSesionCerrada).toHaveBeenLastCalledWith([ana.userId], 'revocada')
    })
})

/**
 * La caché de la cookie (`qb.session_data`) no se entera de una sesión cerrada: quien se llevó un navegador
 * seguía entrando en las rutas de Accesos hasta 1 h después de que lo «cerraran». Con better-auth DE VERDAD y
 * la configuración REAL de `lib/auth.ts` (`session`, `hooks`).
 */
describe('sesión cerrada: la cookie vieja NO obtiene sesión en el servidor', () => {
    const cookieDe = (h: Headers) => (h.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

    async function escenario(conHooks: boolean) {
        const { auth: real } = await import('@/lib/auth');
        const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };
        const auth = betterAuth({
            baseURL: 'http://localhost:3500',
            secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
            database: memoryAdapter(db),
            emailAndPassword: { enabled: true },
            session: real.options.session,
            hooks: conHooks ? real.options.hooks : {},
        });
        // A: el navegador que se llevaron. B: el de Ana, desde donde lo cierra.
        const a = await auth.api.signUpEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' }, returnHeaders: true });
        const b = await auth.api.signInEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123' }, returnHeaders: true });
        return { auth, db, cookieA: cookieDe(a.headers), tokenA: a.response.token as string, cookieB: cookieDe(b.headers) };
    }

    it('la caché de la cookie dura 60 s como mucho (antes 3600)', async () => {
        const { auth: real } = await import('@/lib/auth');
        expect(real.options.session?.cookieCache?.enabled).toBe(true);
        expect(real.options.session?.cookieCache?.maxAge).toBeLessThanOrEqual(60);
    });

    it('tras revokeSession, auth.api.getSession con la cookie vieja da NULL (cada ruta del servidor)', async () => {
        const e = await escenario(true);
        expect(await e.auth.api.getSession({ headers: new Headers({ cookie: e.cookieA }) })).not.toBeNull();
        await e.auth.api.revokeSession({ headers: new Headers({ cookie: e.cookieB }), body: { token: e.tokenA } });
        expect(e.db.session).toHaveLength(1);
        expect(await e.auth.api.getSession({ headers: new Headers({ cookie: e.cookieA }) })).toBeNull();
        // y la de Ana sigue valiendo
        expect(await e.auth.api.getSession({ headers: new Headers({ cookie: e.cookieB }) })).not.toBeNull();
    });

    it('CONTROL: sin ese hook la caché dejaría pasar la cookie vieja (la prueba de arriba distingue)', async () => {
        const e = await escenario(false);
        await e.auth.api.revokeSession({ headers: new Headers({ cookie: e.cookieB }), body: { token: e.tokenA } });
        expect(await e.auth.api.getSession({ headers: new Headers({ cookie: e.cookieA }) })).not.toBeNull();
    });

    it('con `query.disableCookieCache` (resolveSessionUser, callback) también da NULL, con o sin el hook', async () => {
        const e = await escenario(false);
        await e.auth.api.revokeSession({ headers: new Headers({ cookie: e.cookieB }), body: { token: e.tokenA } });
        expect(
            await e.auth.api.getSession({ headers: new Headers({ cookie: e.cookieA }), query: { disableCookieCache: true } }),
        ).toBeNull();
    });
});
