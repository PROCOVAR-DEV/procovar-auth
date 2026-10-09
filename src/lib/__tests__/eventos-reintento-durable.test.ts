/**
 * El aviso GRAVE (`baja`, `revocada`) que no salió porque Redis estaba caído se reintenta EN MEMORIA,
 * con backoff, sin bloquear nunca la respuesta de quien lo originó.
 *
 *  - cola acotada (máx. 1000), sin duplicados por (tipo, alcance, motivo, personas);
 *  - esperas de 2, 5, 15 y 30 s y luego cada 60 s, hasta 10 minutos desde el primer fallo;
 *  - sale con el `tms` ORIGINAL (la marca solo sube) y UNA sola vez;
 *  - al darse por vencido, `logger.error` con los ids internos;
 *  - los relojes llevan `unref()`: un reintento pendiente no impide apagar el proceso.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Comando = [nombre: 'eval' | 'publish', ...args: unknown[]];

const redis = vi.hoisted(() => {
    const comandos: Comando[] = [];
    const pipe = {
        eval: vi.fn((...a: unknown[]) => { comandos.push(['eval', ...a]); return pipe; }),
        publish: vi.fn((...a: unknown[]) => { comandos.push(['publish', ...a]); return pipe; }),
        exec: vi.fn(),
    };
    const duplicado = { pipeline: vi.fn(() => pipe), on: vi.fn() };
    const base = { duplicate: vi.fn(() => duplicado) };
    return { comandos, pipe, base, getRedis: vi.fn(() => base) };
});
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/redis', () => ({ getRedis: redis.getRedis }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/logger', () => ({ logger }));

import {
    publicarSesionCerrada,
    publicarPermisosCambiados,
    avisosPendientes,
    cancelarAvisosPendientes,
    MAX_AVISOS_PENDIENTES,
    VENTANA_REINTENTOS_MS,
    BACKOFF_FINAL_MS,
} from '../eventos-de-sesion';

const AHORA = 1_790_000_000_123;

/** Lo que Redis recibió en los intentos que SÍ salieron bien (mensajes ya publicados). */
let entregados: Array<{ comandos: Comando[] }> = [];
/** El instante (relativo al arranque) de cada intento, salga bien o mal. */
let instantes: number[] = [];
/** Cuántos intentos fallan antes de que Redis conteste. */
let fallos = 0;

beforeEach(() => {
    vi.clearAllMocks();
    cancelarAvisosPendientes();
    globalThis.__procovarEventosRedis = undefined;
    redis.comandos.length = 0;
    redis.getRedis.mockReturnValue(redis.base);
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
    entregados = [];
    instantes = [];
    fallos = 0;
    redis.pipe.exec.mockImplementation(async () => {
        const lote = redis.comandos.splice(0);
        instantes.push(Date.now() - AHORA);
        if (fallos > 0) { fallos -= 1; throw new Error('ECONNREFUSED'); }
        entregados.push({ comandos: lote });
        return lote.map(() => [null, 'OK']);
    });
});
afterEach(() => {
    cancelarAvisosPendientes();
    vi.useRealTimers();
});

const publicados = () =>
    entregados.flatMap((e) => e.comandos.filter((c) => c[0] === 'publish').map((c) => JSON.parse(c[2] as string)));

describe('Redis falla N veces y luego responde', () => {
    it.each(['baja', 'revocada'] as const)('%s: el aviso sale UNA sola vez, con el tms ORIGINAL, y la cola se vacía', async (motivo) => {
        fallos = 6; // el original y 5 reintentos fallan; sale al sexto reintento (t = 112 s)
        await publicarSesionCerrada(['u1', 'u2'], motivo);
        expect(avisosPendientes()).toBe(1);

        await vi.advanceTimersByTimeAsync(200_000);
        expect(publicados()).toHaveLength(1);
        expect(publicados()[0]).toEqual({
            v: 1, tipo: 'sesion-cerrada', userIds: ['u1', 'u2'], tms: AHORA, motivo, alcance: 'todo',
        });
        // También la marca lleva el tms original, no la hora del reintento.
        const marcas = entregados[0].comandos.filter((c) => c[0] === 'eval');
        expect(marcas.map((m) => m[4])).toEqual([String(AHORA), String(AHORA)]);
        expect(Date.now()).toBeGreaterThan(AHORA + 100_000); // el reloj SÍ avanzó: el tms no es el de entonces
        expect(avisosPendientes()).toBe(0);

        // Y no vuelve a salir: ni en los 10 minutos siguientes.
        const intentos = redis.pipe.exec.mock.calls.length;
        await vi.advanceTimersByTimeAsync(VENTANA_REINTENTOS_MS * 2);
        expect(redis.pipe.exec).toHaveBeenCalledTimes(intentos);
        expect(publicados()).toHaveLength(1);
        expect(logger.error).toHaveBeenCalledOnce(); // solo el del primer fallo, con los ids
    });

    it('el calendario es 2, 5, 15 y 30 s y luego cada 60 s, y se rinde antes de pasar de 10 minutos', async () => {
        fallos = Infinity;
        await publicarSesionCerrada(['u-uno', 'u-dos'], 'baja');
        await vi.advanceTimersByTimeAsync(VENTANA_REINTENTOS_MS * 3);
        // Intento original en 0; luego +2, +5, +15, +30 y +60 hasta 592 s (el siguiente, 652 s, pasaría de 600).
        expect(instantes).toEqual([
            0, 2000, 7000, 22000, 52000, 112000, 172000, 232000, 292000, 352000, 412000, 472000, 532000, 592000,
        ]);
        expect(instantes.at(-1)!).toBeLessThanOrEqual(VENTANA_REINTENTOS_MS);
        expect(BACKOFF_FINAL_MS).toBe(60_000);
        expect(avisosPendientes()).toBe(0);
        expect(publicados()).toHaveLength(0);
    });

    it('al darse por vencido registra error CON los ids internos (y nada más sensible)', async () => {
        fallos = Infinity;
        await publicarSesionCerrada(['0192-uuid-a', '0192-uuid-b'], 'baja');
        await vi.advanceTimersByTimeAsync(VENTANA_REINTENTOS_MS * 2);
        const errores = logger.error.mock.calls;
        expect(errores).toHaveLength(2); // el primer fallo y el abandono
        expect(errores[1][0]).toContain('se da por vencido');
        expect(errores[1][1]).toMatchObject({
            tipo: 'sesion-cerrada', motivo: 'baja', userIds: ['0192-uuid-a', '0192-uuid-b'], tms: AHORA, intentos: 13, error: 'ECONNREFUSED',
        });
        expect(Object.keys(errores[1][1]).sort()).toEqual(['error', 'intentos', 'motivo', 'tipo', 'tms', 'userIds']);
        // Los reintentos intermedios van a warn y SIN ids.
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('0192-uuid');
    });
});

describe('no bloquea ni retrasa a quien lo origina', () => {
    it('con Redis caído la acción termina sin que corra ni un milisegundo (el reintento es un reloj aparte)', async () => {
        fallos = Infinity;
        let terminada = false;
        await publicarSesionCerrada(['u1'], 'revocada').then(() => { terminada = true; });
        expect(terminada).toBe(true);
        expect(Date.now()).toBe(AHORA);
        expect(redis.pipe.exec).toHaveBeenCalledOnce();
        expect(avisosPendientes()).toBe(1);
    });

    it('los relojes de reintento llevan unref(): no mantienen vivo el proceso', async () => {
        const reloj = vi.spyOn(globalThis, 'setTimeout');
        fallos = 1;
        await publicarSesionCerrada(['u1'], 'baja');
        const delReintento = reloj.mock.results.filter((r, i) => reloj.mock.calls[i][1] === 2000).map((r) => r.value);
        expect(delReintento).toHaveLength(1);
        expect(delReintento[0].hasRef()).toBe(false);
        // Y el de los reintentos siguientes también.
        fallos = Infinity;
        await vi.advanceTimersByTimeAsync(2000);
        const delSegundo = reloj.mock.results.filter((r, i) => reloj.mock.calls[i][1] === 2000 || reloj.mock.calls[i][1] === 5000).map((r) => r.value);
        expect(delSegundo.length).toBeGreaterThanOrEqual(1);
        for (const t of delSegundo) expect(t.hasRef()).toBe(false);
    });

    it('un aviso que sale bien a la primera no deja nada en la cola', async () => {
        await publicarSesionCerrada(['u1'], 'baja');
        expect(avisosPendientes()).toBe(0);
    });

    it('los motivos NO graves no se reintentan ni entran en la cola', async () => {
        fallos = Infinity;
        await publicarPermisosCambiados(['u1'], 'rol');
        await publicarSesionCerrada(['u1'], 'logout');
        expect(avisosPendientes()).toBe(0);
        await vi.advanceTimersByTimeAsync(VENTANA_REINTENTOS_MS);
        expect(redis.pipe.exec).toHaveBeenCalledTimes(2);
    });
});

describe('sin duplicados', () => {
    it('el mismo aviso (mismas personas en otro orden, mismo motivo) no entra dos veces y sale UNA vez', async () => {
        fallos = 3; // los dos intentos originales y el primer reintento fallan
        await publicarSesionCerrada(['u1', 'u2'], 'baja');
        await publicarSesionCerrada(['u2', 'u1', 'u1'], 'baja');
        expect(avisosPendientes()).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(publicados()).toHaveLength(1);
    });

    it('si se repite, sale con el tms MÁS RECIENTE (la marca solo sube y cubre también al anterior)', async () => {
        fallos = 2;
        await publicarSesionCerrada(['u1'], 'baja'); // tms = AHORA
        vi.setSystemTime(AHORA + 500);
        await publicarSesionCerrada(['u1'], 'baja'); // tms = AHORA + 500
        expect(avisosPendientes()).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(publicados()).toHaveLength(1);
        expect(publicados()[0].tms).toBe(AHORA + 500);
    });

    it('un aviso igual y más reciente que llega MIENTRAS el reintento viaja también sale (no se pierde)', async () => {
        let soltar!: () => void;
        const enVuelo = new Promise<void>((r) => { soltar = r; });
        let llamadas = 0;
        redis.pipe.exec.mockImplementation(async () => {
            const lote = redis.comandos.splice(0);
            llamadas += 1;
            if (llamadas === 1 || llamadas === 3) throw new Error('ECONNREFUSED'); // el original y el repetido
            if (llamadas === 2) await enVuelo; // el reintento a los 2 s se queda a medias
            entregados.push({ comandos: lote });
            return lote.map(() => [null, 'OK']);
        });
        await publicarSesionCerrada(['u1'], 'baja'); // llamada 1: falla, tms = AHORA
        await vi.advanceTimersByTimeAsync(2000); // llamada 2: en vuelo
        vi.setSystemTime(AHORA + 2500);
        await publicarSesionCerrada(['u1'], 'baja'); // llamada 3: falla, se funde con el pendiente
        expect(avisosPendientes()).toBe(1);
        soltar();
        await vi.advanceTimersByTimeAsync(10);
        expect(publicados().map((m) => m.tms)).toEqual([AHORA, AHORA + 2500]);
        expect(avisosPendientes()).toBe(0);
    });

    it('otro motivo, otras personas u otro tipo NO son el mismo aviso', async () => {
        fallos = Infinity;
        await publicarSesionCerrada(['u1'], 'baja');
        await publicarSesionCerrada(['u1'], 'revocada');
        await publicarSesionCerrada(['u2'], 'baja');
        await publicarPermisosCambiados(['u1'], 'baja');
        expect(avisosPendientes()).toBe(4);
    });
});

describe('cola acotada', () => {
    it('no pasa de MAX_AVISOS_PENDIENTES (1000): el que no cabe se registra como perdido, con sus ids', async () => {
        expect(MAX_AVISOS_PENDIENTES).toBe(1000);
        fallos = Infinity;
        for (let i = 0; i < MAX_AVISOS_PENDIENTES; i++) await publicarSesionCerrada([`u${i}`], 'baja');
        expect(avisosPendientes()).toBe(1000);
        logger.error.mockClear();

        await publicarSesionCerrada(['u-de-mas'], 'revocada');
        expect(avisosPendientes()).toBe(1000);
        const errores = logger.error.mock.calls;
        expect(errores.some(([m, d]) => String(m).includes('cola de avisos llena') && d.userIds[0] === 'u-de-mas')).toBe(true);

        // Un aviso que YA estaba en la cola sigue pudiendo repetirse aunque esté llena.
        await publicarSesionCerrada(['u0'], 'baja');
        expect(avisosPendientes()).toBe(1000);
    });
});
