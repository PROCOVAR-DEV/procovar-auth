/**
 * GET /api/user/historial vista desde fuera: sesión obligatoria, la persona sale de la cookie
 * (nunca de la petición), `?pagina=` se normaliza sin error y el tope de lectura se aplica.
 *
 * La ruta corre con la lógica REAL (`historialDeInicios`) contra una base falsa que HACE CASO del
 * `where` y del `take`: así una prueba falla si se quita el filtro por persona, la normalización de
 * la página o el tope, y no sólo si cambia la forma de una llamada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Apunte } from '@/lib/historial-de-inicios';

const sesion = vi.hoisted(() => ({ resolveSessionUser: vi.fn() }));
const datos = vi.hoisted(() => ({ db: null as unknown, espia: vi.fn() }));
vi.mock('@/lib/require-admin', () => sesion);
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/historial-de-inicios', async (original) => {
    const real = await original<typeof import('@/lib/historial-de-inicios')>();
    datos.espia.mockImplementation((userId: string, opts: object) => real.historialDeInicios(userId, opts, datos.db as never));
    return { ...real, historialDeInicios: datos.espia };
});

import { GET } from '../historial/route';

type Where = { userId?: string; action?: { in: string[] }; createdAt?: { gte: Date } };
const ahora = Date.now();
let n = 0;
const web = (userId: string, min: number): Apunte => ({
    id: `a${String(++n).padStart(5, '0')}`,
    userId,
    action: 'auth.signin.web',
    ip: '10.0.0.1',
    ua: null,
    createdAt: new Date(ahora - min * 60_000),
    meta: { sessionId: `s-${userId}-${n}` },
});

function baseFalsa(apuntes: Apunte[]) {
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
    const session = { findMany: vi.fn(async () => []) };
    datos.db = { auditLog, session };
    return { auditLog, session };
}

const pedir = (query = '') => GET(new Request(`http://localhost:3500/api/user/historial${query}`));
const cuerpo = async (query = '') => (await pedir(query)).json() as Promise<{ filas: { id: string }[]; pagina: number; paginas: number; total: number; porPagina: number }>;

const propios = (cuantos: number) => Array.from({ length: cuantos }, (_, i) => web('ana', i + 1));

beforeEach(() => {
    vi.clearAllMocks();
    sesion.resolveSessionUser.mockResolvedValue({ user: { id: 'ana' }, session: { id: 's-ana' } });
    baseFalsa(propios(25));
});

describe('/api/user/historial', () => {
    it('sin sesión: 401 y no se lee nada', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null);
        const res = await pedir();
        expect(res.status).toBe(401);
        expect(datos.espia).not.toHaveBeenCalled();
    });

    it('la forma: { filas, pagina, paginas, total, porPagina }, diez por página, sin caché', async () => {
        const res = await pedir();
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const c = await res.json();
        expect(Object.keys(c).sort()).toEqual(['filas', 'pagina', 'paginas', 'porPagina', 'total']);
        expect(c).toMatchObject({ pagina: 1, paginas: 3, total: 25, porPagina: 10 });
        expect(c.filas).toHaveLength(10);
    });

    it('la persona es la de la sesión: ?userId= de la petición se ignora (y no se ve nada ajeno)', async () => {
        baseFalsa([...propios(3), ...Array.from({ length: 40 }, (_, i) => web('beto', i + 1))]);
        const c = await cuerpo('?userId=beto&user=beto&id=beto');
        expect(datos.espia).toHaveBeenCalledWith('ana', expect.objectContaining({ sesionActualId: 's-ana' }));
        expect(c).toMatchObject({ total: 3, paginas: 1 });
        expect((datos.db as { auditLog: { findMany: ReturnType<typeof vi.fn> } }).auditLog.findMany.mock.calls[0][0].where.userId).toBe('ana');
    });

    it('?pagina=N trae la N-ésima, y cada una trae las suyas', async () => {
        const [p1, p2, p3] = await Promise.all(['?pagina=1', '?pagina=2', '?pagina=3'].map((q) => cuerpo(q)));
        expect([p1.pagina, p2.pagina, p3.pagina]).toEqual([1, 2, 3]);
        expect([p1.filas.length, p2.filas.length, p3.filas.length]).toEqual([10, 10, 5]);
        expect(new Set([...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.id)).size).toBe(25);
    });

    it('?pagina= rara no es un error: se normaliza a una que existe', async () => {
        for (const rara of ['abc', '0', '-1', '-0', '2.5', 'Infinity', '-Infinity', 'NaN', '', '%20', '1,2', '0x2']) {
            const res = await pedir(`?pagina=${rara}`);
            const c = await res.json();
            expect(res.status, rara).toBe(200);
            // «0x2» sí es 2 para Number(): una página que existe. Lo demás, la primera.
            expect(c.pagina, rara).toBe(rara === '0x2' ? 2 : 1);
            expect(c.filas.length, rara).toBeGreaterThan(0);
        }
        for (const enorme of ['4', '99', '1e21', '99999999999999999999999', '1.7976931348623157e308']) {
            const c = await cuerpo(`?pagina=${enorme}`);
            expect(c.pagina, enorme).toBe(3);
            expect(c.filas, enorme).toHaveLength(5);
        }
        expect((await cuerpo()).pagina).toBe(1);
    });

    it('el cursor antiguo ya no existe: ?desde= y ?limite= se ignoran', async () => {
        const c = await cuerpo('?desde=ayer&limite=1000');
        expect(c.filas).toHaveLength(10);
        expect(c.pagina).toBe(1);
    });

    it('sin inicios: una página vacía (1 de 1), no un error', async () => {
        baseFalsa([]);
        expect(await cuerpo('?pagina=7')).toEqual({ filas: [], pagina: 1, paginas: 1, total: 0, porPagina: 10 });
    });

    it('tope duro: lee 500 apuntes como mucho, aunque haya 600 en 90 días', async () => {
        const { auditLog } = baseFalsa(propios(600));
        const c = await cuerpo('?pagina=1000000');
        expect(auditLog.findMany.mock.calls[0][0].take).toBe(500);
        expect(c).toMatchObject({ total: 500, paginas: 50, pagina: 50 });
    });

    it('si la lectura falla: 500 sin detalles', async () => {
        datos.espia.mockRejectedValue(new Error('la base se cayó con datos internos'));
        const res = await pedir();
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'internal_error' });
    });
});
