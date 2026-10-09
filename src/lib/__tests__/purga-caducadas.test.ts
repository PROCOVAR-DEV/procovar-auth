/**
 * La purga de `session` y `refresh_token` caducados hace MÁS de 30 días.
 *
 * La «base» es un Prisma simulado con tablas de verdad (filas que se consultan y se borran, con
 * `where` de `expiresAt < …`, `id in […]` y `take`): así se prueba QUÉ se borra y qué NO, y que quitar
 * el filtro de fecha ponga la prueba en rojo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Fila = { id: string; expiresAt: Date; usedAt?: Date | null; revokedAt?: Date | null };

const tablas = vi.hoisted(() => ({
    session: [] as Array<{ id: string; expiresAt: Date; usedAt?: Date | null; revokedAt?: Date | null }>,
    refresh: [] as Array<{ id: string; expiresAt: Date; usedAt?: Date | null; revokedAt?: Date | null }>,
    lotes: [] as Array<{ tabla: string; ids: number }>,
    falla: null as null | Error,
    bloqueo: null as null | Promise<void>,
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

type Where = { id?: { in: string[] }; expiresAt?: { lt: Date } };
const modelo = (nombre: 'session' | 'refresh') => ({
    findMany: vi.fn(async (a: { where: Where; take: number }) => {
        if (tablas.falla) throw tablas.falla;
        if (tablas.bloqueo) await tablas.bloqueo;
        return tablas[nombre]
            .filter((f) => !a.where.expiresAt || f.expiresAt < a.where.expiresAt.lt)
            .slice(0, a.take)
            .map((f) => ({ id: f.id }));
    }),
    deleteMany: vi.fn(async (a: { where: Where }) => {
        if (tablas.falla) throw tablas.falla;
        const antes = tablas[nombre].length;
        tablas[nombre] = tablas[nombre].filter(
            (f) => !((!a.where.id || a.where.id.in.includes(f.id)) && (!a.where.expiresAt || f.expiresAt < a.where.expiresAt.lt)),
        );
        tablas.lotes.push({ tabla: nombre, ids: a.where.id?.in.length ?? -1 });
        return { count: antes - tablas[nombre].length };
    }),
});
const db = vi.hoisted(() => ({ session: null as unknown, refreshToken: null as unknown }));

const arranque = vi.hoisted(() => ({ syncRbac: vi.fn(), syncClients: vi.fn() }));

vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/lib/logger', () => ({ logger }));
// Lo otro que hace `register()` al arrancar: aquí sólo importa que NO impida programar la purga.
vi.mock('@/rbac/sync', () => ({ syncRbac: arranque.syncRbac }));
vi.mock('@/lib/sync-clients', () => ({ syncClients: arranque.syncClients }));

import {
    purgarCaducadas,
    purgarYRegistrar,
    arrancarPurga,
    detenerPurga,
    DIAS_DE_MARGEN,
    FILAS_POR_LOTE,
    MAX_PASADAS,
    CADA_MS,
} from '../purga-caducadas';

const AHORA = new Date('2026-10-09T16:00:00.000Z').getTime();
const DIA = 86_400_000;
const hace = (dias: number, extraMs = 0) => new Date(AHORA - dias * DIA - extraMs);
const ids = (t: Fila[]) => t.map((f) => f.id).sort();

beforeEach(() => {
    vi.clearAllMocks();
    tablas.session = [];
    tablas.refresh = [];
    tablas.lotes = [];
    tablas.falla = null;
    tablas.bloqueo = null;
    db.session = modelo('session');
    db.refreshToken = modelo('refresh');
    detenerPurga();
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
});
afterEach(() => {
    detenerPurga();
    vi.useRealTimers();
});

describe('qué se borra y qué NO', () => {
    it('una sesión caducada hace 29 días se queda; una hace 31 se va', async () => {
        tablas.session = [
            { id: 's29', expiresAt: hace(29) },
            { id: 's31', expiresAt: hace(31) },
        ];
        const r = await purgarCaducadas();
        expect(ids(tablas.session)).toEqual(['s29']);
        expect(r.sesiones).toBe(1);
    });

    it('el margen es de 30 días justos: exactamente 30 se queda, 30 días y 1 ms se va', async () => {
        expect(DIAS_DE_MARGEN).toBe(30);
        tablas.session = [
            { id: 's30', expiresAt: hace(30) },
            { id: 's30+1ms', expiresAt: hace(30, 1) },
        ];
        await purgarCaducadas();
        expect(ids(tablas.session)).toEqual(['s30']);
    });

    it('las sesiones vigentes y las que caducan en el futuro no se tocan', async () => {
        tablas.session = [
            { id: 'vigente', expiresAt: new Date(AHORA + 7 * DIA) },
            { id: 'acaba-de-caducar', expiresAt: hace(0, 1000) },
            { id: 'revocada-hoy', expiresAt: new Date(AHORA), revokedAt: new Date(AHORA) },
        ];
        await purgarCaducadas();
        expect(ids(tablas.session)).toEqual(['acaba-de-caducar', 'revocada-hoy', 'vigente']);
    });

    it('un refresh USADO pero no caducado se queda (sirve para reconocer la reutilización); también uno revocado', async () => {
        tablas.refresh = [
            { id: 'usado-vivo', expiresAt: new Date(AHORA + 20 * DIA), usedAt: hace(1) },
            { id: 'revocado-vivo', expiresAt: new Date(AHORA + 5 * DIA), revokedAt: hace(1) },
            { id: 'usado-caducado-hace-29', expiresAt: hace(29), usedAt: hace(59) },
            { id: 'usado-caducado-hace-31', expiresAt: hace(31), usedAt: hace(61) },
            { id: 'sin-usar-caducado-hace-31', expiresAt: hace(31), usedAt: null },
            { id: 'revocado-caducado-hace-40', expiresAt: hace(40), revokedAt: hace(50) },
        ];
        const r = await purgarCaducadas();
        expect(ids(tablas.refresh)).toEqual(['revocado-vivo', 'usado-caducado-hace-29', 'usado-vivo']);
        expect(r.refreshTokens).toBe(3);
    });

    it('cada tabla se limpia con la suya: una fila de refresh no borra una sesión ni al revés', async () => {
        tablas.session = [{ id: 'comun', expiresAt: hace(31) }, { id: 'solo-sesion', expiresAt: hace(29) }];
        tablas.refresh = [{ id: 'comun', expiresAt: hace(10) }];
        await purgarCaducadas();
        expect(ids(tablas.session)).toEqual(['solo-sesion']);
        expect(ids(tablas.refresh)).toEqual(['comun']);
    });

    it('el borrado repite el filtro de fecha: una fila que se alargó entre la consulta y el borrado NO se borra', async () => {
        tablas.session = [{ id: 'alargada', expiresAt: hace(31) }];
        const sesion = db.session as ReturnType<typeof modelo>;
        const original = sesion.findMany.getMockImplementation()!;
        sesion.findMany.mockImplementationOnce(async (...a: Parameters<typeof original>) => {
            const r = await original(...a);
            tablas.session[0].expiresAt = new Date(AHORA + DIA); // alguien la alargó justo después
            return r;
        });
        const r = await purgarCaducadas();
        expect(r.sesiones).toBe(0);
        expect(ids(tablas.session)).toEqual(['alargada']);
    });
});

describe('en lotes, para no bloquear la tabla', () => {
    it('2500 caducadas se borran en lotes de 1000, 1000 y 500 (nunca un DELETE gigante)', async () => {
        expect(FILAS_POR_LOTE).toBe(1000);
        tablas.session = Array.from({ length: 2500 }, (_, i) => ({ id: `s${i}`, expiresAt: hace(40) }));
        const r = await purgarCaducadas();
        expect(r.sesiones).toBe(2500);
        expect(tablas.session).toHaveLength(0);
        expect(tablas.lotes.filter((l) => l.tabla === 'session').map((l) => l.ids)).toEqual([1000, 1000, 500]);
    });

    it('como mucho 20 pasadas por tabla y ejecución: lo que sobra espera a la siguiente', async () => {
        expect(MAX_PASADAS).toBe(20);
        tablas.session = Array.from({ length: 25_000 }, (_, i) => ({ id: `s${i}`, expiresAt: hace(40) }));
        const r = await purgarCaducadas();
        expect(r.sesiones).toBe(20_000);
        expect(tablas.session).toHaveLength(5000);
        // La siguiente ejecución sigue donde se quedó.
        expect((await purgarCaducadas()).sesiones).toBe(5000);
    });

    it('sin nada que borrar, no borra nada (ni llama a deleteMany)', async () => {
        tablas.session = [{ id: 'a', expiresAt: hace(1) }];
        await purgarCaducadas();
        expect((db.session as ReturnType<typeof modelo>).deleteMany).not.toHaveBeenCalled();
        expect((db.refreshToken as ReturnType<typeof modelo>).deleteMany).not.toHaveBeenCalled();
    });
});

describe('al arrancar y cada 24 h, sin tumbar nada', () => {
    it('arrancarPurga no espera a la base (vuelve ya) y purga en segundo plano', async () => {
        tablas.session = [{ id: 's31', expiresAt: hace(31) }];
        let soltar!: () => void;
        tablas.bloqueo = new Promise<void>((r) => { soltar = r; }); // la base tarda
        arrancarPurga(); // síncrona: si esperase a la base, el test no pasaría de aquí
        await vi.advanceTimersByTimeAsync(0);
        expect(tablas.session).toHaveLength(1); // aún no ha borrado nada
        soltar();
        await vi.advanceTimersByTimeAsync(0);
        expect(tablas.session).toHaveLength(0);
    });

    it('purga una vez al arrancar y de nuevo a las 24 h, y no antes', async () => {
        tablas.session = [{ id: 's31', expiresAt: hace(31) }];
        arrancarPurga();
        await vi.advanceTimersByTimeAsync(0);
        expect(tablas.session).toHaveLength(0);
        expect(logger.info).toHaveBeenCalledWith('[purga] caducadas borradas', { sesiones: 1, refreshTokens: 0 });

        tablas.session = [{ id: 'nueva-caducada', expiresAt: hace(100) }];
        await vi.advanceTimersByTimeAsync(CADA_MS - 1);
        expect(tablas.session).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(tablas.session).toHaveLength(0);
        expect(CADA_MS).toBe(24 * 3600 * 1000);
    });

    it('es idempotente: llamarla dos veces programa UNA sola', async () => {
        arrancarPurga();
        arrancarPurga();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1); // un solo reloj de 24 h
        // Y a las 24 h corre UNA vez, no dos.
        const antes = (db.session as ReturnType<typeof modelo>).findMany.mock.calls.length;
        await vi.advanceTimersByTimeAsync(CADA_MS);
        expect((db.session as ReturnType<typeof modelo>).findMany.mock.calls.length - antes).toBe(1);
    });

    it('el reloj lleva unref(): no impide apagar el proceso', () => {
        arrancarPurga();
        const reloj = globalThis.__procovarPurgaProgramada as unknown as { hasRef(): boolean };
        expect(reloj.hasRef()).toBe(false);
    });

    it('si la base falla, NO lanza ni tumba: lo registra y la siguiente ejecución lo reintenta', async () => {
        tablas.falla = new Error('base caída');
        expect(() => arrancarPurga()).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo purgar'), { error: 'base caída' });
        await expect(purgarYRegistrar()).resolves.toBeUndefined();

        tablas.falla = null;
        tablas.session = [{ id: 's31', expiresAt: hace(31) }];
        await vi.advanceTimersByTimeAsync(CADA_MS);
        expect(tablas.session).toHaveLength(0);
    });

    it('purgarCaducadas SÍ lanza si la base falla (quien la llama decide)', async () => {
        tablas.falla = new Error('base caída');
        await expect(purgarCaducadas()).rejects.toThrow('base caída');
    });

    it('una purga lenta no se solapa con la siguiente', async () => {
        let soltar!: () => void;
        const lenta = new Promise<void>((r) => { soltar = r; });
        const sesion = db.session as ReturnType<typeof modelo>;
        sesion.findMany.mockImplementationOnce(async () => { await lenta; return []; });
        const primera = purgarYRegistrar();
        await purgarYRegistrar(); // la segunda ve que hay una en marcha y vuelve sin hacer nada
        expect(sesion.findMany).toHaveBeenCalledTimes(1);
        soltar();
        await primera;
    });
});

describe('el arranque de la aplicación la programa (instrumentation.ts)', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_RUNTIME', 'nodejs');
        arranque.syncRbac.mockResolvedValue({});
        arranque.syncClients.mockResolvedValue({});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('register() programa la purga una vez', async () => {
        const { register } = await import('../../instrumentation');
        await register();
        expect(globalThis.__procovarPurgaProgramada).toBeDefined();
    });

    it('aunque falle el auto-sync del catálogo, register no lanza y la purga se programa igualmente', async () => {
        arranque.syncRbac.mockRejectedValue(new Error('base caída'));
        const { register } = await import('../../instrumentation');
        await expect(register()).resolves.toBeUndefined();
        expect(globalThis.__procovarPurgaProgramada).toBeDefined();
    });

    it('fuera de Node (edge) no programa nada', async () => {
        vi.stubEnv('NEXT_RUNTIME', 'edge');
        const { register } = await import('../../instrumentation');
        await register();
        expect(globalThis.__procovarPurgaProgramada).toBeUndefined();
    });
});
