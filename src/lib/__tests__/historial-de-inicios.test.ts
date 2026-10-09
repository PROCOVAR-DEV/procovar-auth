/**
 * «Historial de inicios de sesión»: lo que decide quién ve qué y qué cuenta como un inicio.
 * La lógica es pura (`iniciosDeLaPersona`); `historialDeInicios` se prueba con una base falsa
 * que HACE CASO del `where` (como la real), para que quitar un filtro se note.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    iniciosDeLaPersona,
    historialDeInicios,
    limiteDePagina,
    POR_PAGINA,
    TOPE_POR_PAGINA,
    type Apunte,
} from '../historial-de-inicios';

vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const AHORA = new Date('2026-10-08T12:00:00.000Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000);
const dias = (d: number) => new Date(AHORA.getTime() - d * 86_400_000);
const VIVAS = new Set<string>();

let n = 0;
const apunte = (o: Partial<Apunte> & { action: string }): Apunte => ({
    id: `a${String(++n).padStart(4, '0')}`,
    userId: 'ana',
    ip: '10.0.0.1',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36',
    createdAt: hace(1),
    meta: null,
    ...o,
});
const web = (min: number, sesion: string, o: Partial<Apunte> = {}) =>
    apunte({ action: 'auth.signin.web', createdAt: hace(min), meta: { sessionId: sesion }, ...o });

const ctx = (o: Partial<Parameters<typeof iniciosDeLaPersona>[1]> = {}) => ({
    userId: 'ana',
    ahora: AHORA,
    vivas: VIVAS,
    ...o,
});

describe('limiteDePagina', () => {
    it('10 por defecto y 50 como tope duro', () => {
        expect(limiteDePagina(undefined)).toBe(POR_PAGINA);
        expect(limiteDePagina(null)).toBe(POR_PAGINA);
        expect(limiteDePagina('abc')).toBe(POR_PAGINA);
        expect(limiteDePagina(0)).toBe(POR_PAGINA);
        expect(limiteDePagina(-5)).toBe(POR_PAGINA);
        expect(limiteDePagina('7')).toBe(7);
        expect(limiteDePagina(50)).toBe(50);
        expect(limiteDePagina(51)).toBe(TOPE_POR_PAGINA);
        expect(limiteDePagina(1_000_000)).toBe(TOPE_POR_PAGINA);
        expect(TOPE_POR_PAGINA).toBe(50);
    });
});

describe('iniciosDeLaPersona', () => {
    it('una persona NO ve los inicios de otra', () => {
        const mios = web(5, 's-ana');
        const ajeno = web(3, 's-beto', { userId: 'beto' });
        const sinPersona = web(2, 's-nadie', { userId: null });
        const { filas } = iniciosDeLaPersona([ajeno, mios, sinPersona], ctx());
        expect(filas.map((f) => f.id)).toEqual([mios.id]);
    });

    it('el tope se aplica aunque pidan más, y avisa de que hay más', () => {
        const todos = Array.from({ length: 120 }, (_, i) => web(i + 1, `s${i}`));
        const grande = iniciosDeLaPersona(todos, ctx({ limite: 1000 }));
        expect(grande.filas).toHaveLength(TOPE_POR_PAGINA);
        expect(grande.siguiente).not.toBeNull();
        expect(iniciosDeLaPersona(todos, ctx()).filas).toHaveLength(POR_PAGINA);
    });

    it('más recientes primero, venga como venga la entrada', () => {
        const a = web(30, 's1');
        const b = web(10, 's2');
        const c = apunte({ action: 'auth.apk.login', createdAt: hace(20), meta: { sessionId: 's3' } });
        const { filas } = iniciosDeLaPersona([a, c, b], ctx());
        expect(filas.map((f) => f.id)).toEqual([b.id, c.id, a.id]);
    });

    it('pagina por cursor: `desde` es la fecha del último visto, sin repetir ni saltar', () => {
        const todos = Array.from({ length: 25 }, (_, i) => web(i + 1, `s${i}`));
        const p1 = iniciosDeLaPersona(todos, ctx());
        const p2 = iniciosDeLaPersona(todos, ctx({ desde: new Date(p1.siguiente!) }));
        const p3 = iniciosDeLaPersona(todos, ctx({ desde: new Date(p2.siguiente!) }));
        expect([p1.filas.length, p2.filas.length, p3.filas.length]).toEqual([10, 10, 5]);
        expect(p3.siguiente).toBeNull();
        const ids = [...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.id);
        expect(new Set(ids).size).toBe(25);
        expect(ids).toEqual([...todos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((a) => a.id));
    });

    it('sólo los últimos 90 días', () => {
        const viejo = web(0, 's-viejo', { createdAt: dias(91) });
        const justo = web(0, 's-justo', { createdAt: dias(89) });
        const { filas } = iniciosDeLaPersona([viejo, justo], ctx());
        expect(filas.map((f) => f.id)).toEqual([justo.id]);
    });

    it('un SSO silencioso hacia otra aplicación (auth.code.exchange) NO es un inicio de sesión', () => {
        const exchange = apunte({ action: 'auth.code.exchange', createdAt: hace(1) });
        const callback = apunte({ action: 'callback.create', createdAt: hace(2) });
        const denegado = apunte({ action: 'auth.apk.denied', createdAt: hace(3), meta: { sessionId: 's-x' } });
        const fallido = apunte({ action: 'auth.apk.login_failed', createdAt: hace(4) });
        const real = web(5, 's-real');
        const { filas } = iniciosDeLaPersona([exchange, callback, denegado, fallido, real], ctx());
        expect(filas.map((f) => f.id)).toEqual([real.id]);
    });

    it('la APK sale una vez y como aparato: su auth.signin.web (misma sesión) se descarta', () => {
        const apk = apunte({
            action: 'auth.apk.login',
            createdAt: hace(5),
            ua: 'Dart/3.5 (dart:io)',
            meta: { sessionId: 's-apk' },
        });
        const eco = web(5, 's-apk', { ua: 'Dart/3.5 (dart:io)' });
        const denegada = web(8, 's-negada', { ua: 'Dart/3.5 (dart:io)' });
        const negadaApk = apunte({ action: 'auth.apk.denied', createdAt: hace(8), meta: { sessionId: 's-negada' } });
        const { filas } = iniciosDeLaPersona([eco, apk, denegada, negadaApk], ctx());
        expect(filas.map((f) => [f.id, f.tipo])).toEqual([[apk.id, 'aparato']]);
    });

    it('el auth.login de antes del hook cuenta; el que repite a un auth.signin.web, no', () => {
        const viejo = apunte({ action: 'auth.login', createdAt: dias(10) });
        const nuevoWeb = web(5, 's-n');
        const nuevoLogin = apunte({ action: 'auth.login', createdAt: new Date(nuevoWeb.createdAt.getTime() + 400) });
        const { filas } = iniciosDeLaPersona([viejo, nuevoLogin, nuevoWeb], ctx());
        expect(filas.map((f) => f.id)).toEqual([nuevoWeb.id, viejo.id]);
        // El login viejo no sabe de qué sesión era: no se inventa si sigue abierta.
        expect(filas[1].estaActiva).toBeNull();
    });

    it('estaActiva cruza con las sesiones vivas y esActual marca la de la petición', () => {
        const abierta = web(1, 's-abierta');
        const cerrada = web(2, 's-cerrada');
        const { filas } = iniciosDeLaPersona([abierta, cerrada], ctx({ vivas: new Set(['s-abierta']), sesionActualId: 's-abierta' }));
        expect(filas.map((f) => [f.estaActiva, f.esActual])).toEqual([
            [true, true],
            [false, false],
        ]);
    });

    it('la fila no lleva ni token ni id de sesión, y la IP/agente vacíos son null', () => {
        const { filas } = iniciosDeLaPersona([web(1, 's-1', { ip: '  ', ua: '' })], ctx());
        expect(Object.keys(filas[0]).sort()).toEqual(['cuando', 'esActual', 'estaActiva', 'id', 'ip', 'tipo', 'ua']);
        expect(filas[0]).toMatchObject({ ip: null, ua: null, tipo: 'navegador', cuando: hace(1).toISOString() });
    });
});

describe('historialDeInicios (contra una base falsa que respeta el where)', () => {
    type Where = { userId?: string; action?: { in: string[] }; createdAt?: { gte: Date } };
    function baseFalsa(apuntes: Apunte[], sesiones: { id: string; userId: string }[] = []) {
        const auditLog = {
            findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
                apuntes
                    .filter(
                        (a) =>
                            (where.userId === undefined || a.userId === where.userId) &&
                            (!where.action || where.action.in.includes(a.action)) &&
                            (!where.createdAt || a.createdAt >= where.createdAt.gte),
                    )
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                    .slice(0, take),
            ),
        };
        const session = {
            findMany: vi.fn(async ({ where }: { where: Where }) =>
                sesiones.filter((x) => where.userId === undefined || x.userId === where.userId),
            ),
        };
        return { db: { auditLog, session } as never as Parameters<typeof historialDeInicios>[2], auditLog, session };
    }

    it('consulta SIEMPRE por la persona, también las sesiones vivas', async () => {
        const { db, auditLog, session } = baseFalsa(
            [web(1, 's-ana'), web(2, 's-beto', { userId: 'beto' })],
            [{ id: 's-ana', userId: 'ana' }, { id: 's-beto', userId: 'beto' }],
        );
        const r = await historialDeInicios('ana', { ahora: AHORA, sesionActualId: 's-ana' }, db);
        expect(r.filas).toHaveLength(1);
        expect(r.filas[0]).toMatchObject({ estaActiva: true, esActual: true });
        expect(auditLog.findMany.mock.calls[0][0].where.userId).toBe('ana');
        expect(session.findMany.mock.calls[0][0].where.userId).toBe('ana');
    });

    it('lee sólo las acciones de inicio: nunca auth.code.exchange', async () => {
        const { db, auditLog } = baseFalsa([apunte({ action: 'auth.code.exchange' }), web(1, 's')]);
        const r = await historialDeInicios('ana', { ahora: AHORA }, db);
        expect(r.filas).toHaveLength(1);
        expect(auditLog.findMany.mock.calls[0][0].where.action!.in).not.toContain('auth.code.exchange');
    });

    it('sin persona (cadena vacía) no consulta nada: un where sin userId sería «todas»', async () => {
        const { db, auditLog, session } = baseFalsa([web(1, 's')]);
        expect(await historialDeInicios('', { ahora: AHORA }, db)).toEqual({ filas: [], siguiente: null });
        expect(auditLog.findMany).not.toHaveBeenCalled();
        expect(session.findMany).not.toHaveBeenCalled();
    });

    it('el tope también aguanta por esta vía', async () => {
        const { db } = baseFalsa(Array.from({ length: 80 }, (_, i) => web(i + 1, `s${i}`)));
        const r = await historialDeInicios('ana', { ahora: AHORA, limite: 9999 }, db);
        expect(r.filas).toHaveLength(TOPE_POR_PAGINA);
    });
});
