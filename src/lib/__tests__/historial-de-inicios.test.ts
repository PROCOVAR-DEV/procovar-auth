/**
 * «Historial de inicios de sesión»: lo que decide quién ve qué y qué cuenta como un inicio.
 * La lógica es pura (`iniciosDeLaPersona`); `historialDeInicios` se prueba con una base falsa
 * que HACE CASO del `where` (como la real), para que quitar un filtro se note.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    iniciosDeLaPersona,
    historialDeInicios,
    paginaValida,
    MAX_LEIDOS,
    POR_PAGINA,
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

describe('paginaValida', () => {
    it('lo que no es un entero >= 1 es la primera: NaN, 0, negativos, decimales, Infinity, texto, null', () => {
        for (const mala of [NaN, 0, -1, -7, 2.5, 0.9, Infinity, -Infinity, 'abc', '', ' ', '2.5', '-3', '0', 'Infinity', 'NaN', null, undefined]) {
            expect(paginaValida(mala, 5), String(mala)).toBe(1);
        }
    });

    it('una que existe se respeta, venga como número o como texto', () => {
        expect(paginaValida(1, 5)).toBe(1);
        expect(paginaValida(3, 5)).toBe(3);
        expect(paginaValida('3', 5)).toBe(3);
        expect(paginaValida(5, 5)).toBe(5);
    });

    it('una enorme (más allá de la última) es la última, sin desbordar: 6, 1e21, 1e309', () => {
        for (const grande of [6, 99, 1e21, '1e21', Number.MAX_VALUE, '99999999999999999999999']) {
            expect(paginaValida(grande, 5), String(grande)).toBe(5);
        }
        expect(paginaValida(1e21, 1)).toBe(1);
    });

    it('siempre cae en 1..paginas, también si paginas llegara roto (0, NaN)', () => {
        for (const paginas of [1, 2, 7]) {
            for (const pedida of [NaN, 0, -1, 1, 2, 3, 1e21, Infinity, 'x']) {
                const r = paginaValida(pedida as never, paginas);
                expect(r).toBeGreaterThanOrEqual(1);
                expect(r).toBeLessThanOrEqual(paginas);
                expect(Number.isInteger(r)).toBe(true);
            }
        }
        expect(paginaValida(3, 0)).toBe(1);
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

    it('diez por página; sin pagina pedida es la primera, y dice cuántas hay', () => {
        const todos = Array.from({ length: 25 }, (_, i) => web(i + 1, `s${i}`));
        const r = iniciosDeLaPersona(todos, ctx());
        expect(r.filas).toHaveLength(10);
        expect(r).toMatchObject({ pagina: 1, paginas: 3, total: 25, porPagina: 10 });
        expect(POR_PAGINA).toBe(10);
    });

    it('más recientes primero, venga como venga la entrada', () => {
        const a = web(30, 's1');
        const b = web(10, 's2');
        const c = apunte({ action: 'auth.apk.login', createdAt: hace(20), meta: { sessionId: 's3' } });
        const { filas } = iniciosDeLaPersona([a, c, b], ctx());
        expect(filas.map((f) => f.id)).toEqual([b.id, c.id, a.id]);
    });

    it('pagina por número: cada página trae las suyas, sin repetir ni saltar, y paginas es el techo', () => {
        const todos = Array.from({ length: 25 }, (_, i) => web(i + 1, `s${i}`));
        const [p1, p2, p3] = [1, 2, 3].map((pagina) => iniciosDeLaPersona(todos, ctx({ pagina })));
        expect([p1.filas.length, p2.filas.length, p3.filas.length]).toEqual([10, 10, 5]);
        expect([p1.pagina, p2.pagina, p3.pagina]).toEqual([1, 2, 3]);
        for (const p of [p1, p2, p3]) expect(p).toMatchObject({ paginas: 3, total: 25 });
        const ids = [...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.id);
        expect(new Set(ids).size).toBe(25);
        expect(ids).toEqual([...todos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((a) => a.id));
    });

    it('paginas es exacto en los bordes: 0, 1, 10, 11, 20 y 21 inicios', () => {
        const de = (n: number) => Array.from({ length: n }, (_, i) => web(i + 1, `s${i}`));
        const paginas = (n: number) => iniciosDeLaPersona(de(n), ctx()).paginas;
        expect([0, 1, 10, 11, 20, 21].map(paginas)).toEqual([1, 1, 1, 2, 2, 3]);
        // Sin inicios: una página vacía, no «página 0 de 0».
        expect(iniciosDeLaPersona([], ctx())).toMatchObject({ filas: [], pagina: 1, paginas: 1, total: 0 });
        // Justo diez: la última tiene diez, no cero.
        expect(iniciosDeLaPersona(de(10), ctx({ pagina: 1 })).filas).toHaveLength(10);
        expect(iniciosDeLaPersona(de(11), ctx({ pagina: 2 })).filas).toHaveLength(1);
    });

    it('una pagina rara no rompe ni vacía la lista: la normaliza a una que existe', () => {
        const todos = Array.from({ length: 25 }, (_, i) => web(i + 1, `s${i}`));
        const quePagina = (pagina: string | number | null) => {
            const r = iniciosDeLaPersona(todos, ctx({ pagina }));
            expect(r.filas.length, String(pagina)).toBeGreaterThan(0);
            return r.pagina;
        };
        expect(['abc', '0', '-1', '2.5', 'Infinity', 'NaN', NaN, 0, -3, 1.5, null, ''].map(quePagina)).toEqual(Array(12).fill(1));
        expect(['4', 4, '1e21', 1e21, 999].map(quePagina)).toEqual([3, 3, 3, 3, 3]);
        expect(quePagina('2')).toBe(2);
    });

    it('el recuento sale de la lista ya deduplicada: un auth.login repetido no cuenta ni parte páginas', () => {
        // 11 inicios web + sus 11 eco de auth.login (a menos de 30 s) = 11, no 22 → 2 páginas, no 3.
        const webs = Array.from({ length: 11 }, (_, i) => web(i * 5 + 1, `s${i}`));
        const ecos = webs.map((w) => apunte({ action: 'auth.login', createdAt: new Date(w.createdAt.getTime() + 400) }));
        // Y 10 aparatos con su eco de auth.signin.web (misma sesión): tampoco duplican.
        const apks = Array.from({ length: 10 }, (_, i) =>
            apunte({ action: 'auth.apk.login', createdAt: hace(100 + i), meta: { sessionId: `a${i}` } }),
        );
        const ecosApk = apks.map((a, i) => web(100 + i, `a${i}`));
        const todos = [...ecos, ...ecosApk, ...webs, ...apks];
        const p1 = iniciosDeLaPersona(todos, ctx({ pagina: 1 }));
        const p3 = iniciosDeLaPersona(todos, ctx({ pagina: 3 }));
        expect(p1).toMatchObject({ total: 21, paginas: 3 });
        expect(p3.pagina).toBe(3);
        expect(p3.filas).toHaveLength(1);
        const ids = [1, 2, 3].flatMap((pagina) => iniciosDeLaPersona(todos, ctx({ pagina })).filas.map((f) => f.id));
        expect(new Set(ids).size).toBe(21);
    });

    it('los ajenos no cuentan en total ni en paginas', () => {
        const mios = Array.from({ length: 3 }, (_, i) => web(i + 1, `s${i}`));
        const ajenos = Array.from({ length: 30 }, (_, i) => web(i + 1, `x${i}`, { userId: 'beto' }));
        expect(iniciosDeLaPersona([...ajenos, ...mios], ctx())).toMatchObject({ total: 3, paginas: 1 });
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
        expect(await historialDeInicios('', { ahora: AHORA }, db)).toEqual({
            filas: [],
            pagina: 1,
            paginas: 1,
            total: 0,
            porPagina: POR_PAGINA,
        });
        expect(auditLog.findMany).not.toHaveBeenCalled();
        expect(session.findMany).not.toHaveBeenCalled();
    });

    it('pagina por esta vía y normaliza la que llega rara', async () => {
        const { db } = baseFalsa(Array.from({ length: 25 }, (_, i) => web(i + 1, `s${i}`)));
        const p3 = await historialDeInicios('ana', { ahora: AHORA, pagina: '3' }, db);
        expect(p3).toMatchObject({ pagina: 3, paginas: 3, total: 25 });
        expect(p3.filas).toHaveLength(5);
        for (const rara of ['abc', '0', '-1', '2.5', 'Infinity', null]) {
            expect((await historialDeInicios('ana', { ahora: AHORA, pagina: rara }, db)).pagina, String(rara)).toBe(1);
        }
        expect((await historialDeInicios('ana', { ahora: AHORA, pagina: '1e21' }, db)).pagina).toBe(3);
    });

    it('lee como mucho 500 apuntes (tope duro): ni el total ni las páginas pasan de ahí', async () => {
        const { db, auditLog } = baseFalsa(Array.from({ length: 600 }, (_, i) => web(i + 1, `s${i}`)));
        const r = await historialDeInicios('ana', { ahora: AHORA, pagina: '9999' }, db);
        expect(MAX_LEIDOS).toBe(500);
        expect(auditLog.findMany.mock.calls[0][0].take).toBe(500);
        expect(r).toMatchObject({ total: 500, paginas: 50, pagina: 50 });
        expect(r.filas).toHaveLength(10);
    });
});
