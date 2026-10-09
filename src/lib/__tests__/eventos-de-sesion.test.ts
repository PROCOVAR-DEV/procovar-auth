/**
 * El módulo que empuja el aviso a las aplicaciones, probado contra el CONTRATO:
 * canal, forma del mensaje, marca (clave literal, DB de sesiones, 8 días) y las dos
 * promesas de robustez —un fallo de Redis no rompe la acción, y la acción no espera
 * más de ~1 s—.
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
    return { comandos, pipe, duplicado, base, getRedis: vi.fn(() => base) };
});
const db = vi.hoisted(() => ({
    user: { findMany: vi.fn() },
    member: { findMany: vi.fn() },
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/redis', () => ({ getRedis: redis.getRedis }));
vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/lib/logger', () => ({ logger }));

import {
    publicarSesionCerrada,
    publicarPermisosCambiados,
    personasConRol,
    personasDeLaSucursal,
    CANAL_DE_EVENTOS,
    ESPERA_MAX_MS,
    MARCA_SOLO_SUBE,
    REINTENTO_MS,
    BACKOFF_MS,
    avisosPendientes,
    cancelarAvisosPendientes,
} from '../eventos-de-sesion';

const AHORA = 1_790_000_000_123; // un instante con milisegundos, para distinguirlos de segundos

const mensajes = () =>
    redis.comandos.filter((c) => c[0] === 'publish').map((c) => JSON.parse(c[2] as string));
// Una marca = un EVAL del script «sólo sube»: [eval, script, 1, clave, tms, ttl].
const marcas = () => redis.comandos.filter((c) => c[0] === 'eval');

beforeEach(() => {
    vi.clearAllMocks();
    cancelarAvisosPendientes(); // la cola es global: que un test no herede los avisos del anterior
    redis.comandos.length = 0;
    globalThis.__procovarEventosRedis = undefined;
    redis.getRedis.mockReturnValue(redis.base);
    redis.pipe.exec.mockImplementation(async () => redis.comandos.map(() => [null, 'OK']));
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
});
afterEach(() => {
    cancelarAvisosPendientes();
    vi.useRealTimers();
});

describe('el mensaje y la marca tienen la forma del contrato', () => {
    it('publica en el canal exacto un JSON con v, tipo, userIds, tms (ms) y motivo', async () => {
        await publicarSesionCerrada(['u1', 'u2'], 'logout');
        const [pub] = redis.comandos.filter((c) => c[0] === 'publish');
        expect(pub[1]).toBe('procovar:auth:eventos');
        expect(pub[1]).toBe(CANAL_DE_EVENTOS);
        expect(JSON.parse(pub[2] as string)).toEqual({
            v: 1,
            tipo: 'sesion-cerrada',
            userIds: ['u1', 'u2'],
            tms: AHORA,
            motivo: 'logout',
            alcance: 'web',
        });
        // El orden de los campos también es el del contrato.
        expect(Object.keys(JSON.parse(pub[2] as string))).toEqual(['v', 'tipo', 'userIds', 'tms', 'motivo', 'alcance']);
    });

    it('el tms son MILISEGUNDOS, no segundos', async () => {
        await publicarPermisosCambiados(['u1'], 'rol');
        expect(mensajes()[0].tms).toBe(AHORA);
        expect(mensajes()[0].tms).toBeGreaterThan(1e12);
    });

    it('escribe una marca por persona (script «sólo sube»): clave literal, valor = tms, EX 691200', async () => {
        await publicarSesionCerrada(['u1', 'u2'], 'baja');
        expect(marcas()).toEqual([
            ['eval', MARCA_SOLO_SUBE, 1, 'procovar:auth:invalida:todo:u1', String(AHORA), '691200'],
            ['eval', MARCA_SOLO_SUBE, 1, 'procovar:auth:invalida:todo:u2', String(AHORA), '691200'],
        ]);
    });

    it('las marcas van ANTES del mensaje', async () => {
        await publicarPermisosCambiados(['u1', 'u2', 'u3'], 'llaves');
        expect(redis.comandos.map((c) => c[0])).toEqual(['eval', 'eval', 'eval', 'publish']);
    });

    it('usa un duplicado SIN keyPrefix del cliente de la DB de sesiones (6)', async () => {
        await publicarSesionCerrada(['u1'], 'logout');
        expect(redis.getRedis).toHaveBeenCalledWith('sessions');
        expect(redis.base.duplicate).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: '' }));
        expect(redis.duplicado.pipeline).toHaveBeenCalled();
    });

    it('el tipo es el que se pide: permisos-cambiados no sale como sesion-cerrada', async () => {
        await publicarPermisosCambiados(['u1'], 'membresia');
        expect(mensajes()[0].tipo).toBe('permisos-cambiados');
        redis.comandos.length = 0;
        await publicarSesionCerrada(['u1'], 'revocada');
        expect(mensajes()[0].tipo).toBe('sesion-cerrada');
    });
});

describe('alcance: logout es sólo la web, todo lo demás es de todo', () => {
    it('logout → alcance web y escribe SOLO la marca web (no la todo)', async () => {
        await publicarSesionCerrada(['u1'], 'logout');
        expect(mensajes()[0].alcance).toBe('web');
        expect(marcas().map((m) => m[3])).toEqual(['procovar:auth:invalida:web:u1']);
    });

    it.each(['revocada', 'baja', 'rol', 'llaves', 'admin', 'membresia'] as const)(
        '%s → alcance todo y escribe SOLO la marca todo (la web la mira también)',
        async (motivo) => {
            redis.comandos.length = 0;
            await publicarPermisosCambiados(['u1'], motivo);
            expect(mensajes()[0].alcance).toBe('todo');
            expect(marcas().map((m) => m[3])).toEqual(['procovar:auth:invalida:todo:u1']);
        },
    );

    it('el alcance también va en cada mensaje de un lote partido', async () => {
        await publicarSesionCerrada(Array.from({ length: 501 }, (_, i) => `u${i}`), 'logout');
        expect(mensajes().map((m) => m.alcance)).toEqual(['web', 'web']);
    });
});

describe('ids repetidos y lotes', () => {
    it('quita los ids duplicados y los vacíos', async () => {
        await publicarSesionCerrada(['u1', 'u1', '', 'u2', 'u1'], 'logout');
        expect(mensajes()).toHaveLength(1);
        expect(mensajes()[0].userIds).toEqual(['u1', 'u2']);
        expect(marcas()).toHaveLength(2);
    });

    it('sin ids no toca Redis', async () => {
        await publicarSesionCerrada([], 'logout');
        await publicarPermisosCambiados(['', ''], 'rol');
        expect(redis.getRedis).not.toHaveBeenCalled();
    });

    it('más de 500 ids se parten en varios mensajes de 500 como máximo, con el mismo tms', async () => {
        const ids = Array.from({ length: 1203 }, (_, i) => `u${i}`);
        await publicarPermisosCambiados(ids, 'llaves');
        const m = mensajes();
        expect(m.map((x) => x.userIds.length)).toEqual([500, 500, 203]);
        expect(new Set(m.map((x) => x.tms)).size).toBe(1);
        expect(m.flatMap((x) => x.userIds)).toEqual(ids);
        expect(marcas()).toHaveLength(1203);
    });

    it('justo 500 es un solo mensaje', async () => {
        await publicarSesionCerrada(Array.from({ length: 500 }, (_, i) => `u${i}`), 'revocada');
        expect(mensajes()).toHaveLength(1);
    });
});

describe('Redis caído o lento NUNCA rompe la acción', () => {
    it('Redis sin configurar (getRedis lanza): no propaga, lo registra', async () => {
        redis.getRedis.mockImplementation(() => { throw new Error('Redis not configured'); });
        await expect(publicarSesionCerrada(['u1'], 'logout')).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('la conexión rechaza: no propaga, lo registra', async () => {
        redis.pipe.exec.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(publicarPermisosCambiados(['u1'], 'rol')).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('un comando que falla dentro del pipeline (exec no rechaza): también se registra', async () => {
        redis.pipe.exec.mockResolvedValue([[new Error('READONLY'), null], [null, 1]]);
        await expect(publicarSesionCerrada(['u1'], 'logout')).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('un motivo NO grave (rol, llaves, logout…) registra un warn sin ids: sólo cuántas personas, y no reintenta', async () => {
        redis.pipe.exec.mockRejectedValue(new Error('boom'));
        await publicarPermisosCambiados(['uuid-secreto-1', 'uuid-secreto-2'], 'rol');
        await vi.advanceTimersByTimeAsync(REINTENTO_MS * 3);
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('uuid-secreto');
        expect(logger.warn.mock.calls[0][1]).toMatchObject({ personas: 2, motivo: 'rol' });
        expect(logger.error).not.toHaveBeenCalled();
        expect(redis.pipe.exec).toHaveBeenCalledOnce();
    });
});

describe('los avisos GRAVES (baja, revocada) no se pierden en silencio', () => {
    it.each(['baja', 'revocada'] as const)('%s con Redis caído: error CON los ids internos y un reintento a los ~2 s', async (motivo) => {
        redis.pipe.exec.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(publicarSesionCerrada(['uuid-1', 'uuid-2'], motivo)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledOnce();
        expect(logger.error.mock.calls[0][1]).toMatchObject({ motivo, userIds: ['uuid-1', 'uuid-2'], error: 'ECONNREFUSED' });
        expect(redis.pipe.exec).toHaveBeenCalledOnce(); // aún no se ha reintentado: no bloquea

        await vi.advanceTimersByTimeAsync(REINTENTO_MS - 1);
        expect(redis.pipe.exec).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2);
        expect(redis.pipe.exec).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledOnce(); // el reintento funcionó: no hay segundo error
    });

    it('el reintento lleva el MISMO tms que el original, no la hora de entonces', async () => {
        redis.pipe.exec.mockRejectedValueOnce(new Error('caído'));
        await publicarSesionCerrada(['u1'], 'baja');
        redis.comandos.length = 0;
        vi.setSystemTime(AHORA + 60_000);
        await vi.advanceTimersByTimeAsync(REINTENTO_MS);
        expect(mensajes()[0].tms).toBe(AHORA);
        expect(marcas()[0][4]).toBe(String(AHORA));
    });

    it('si el primer reintento también falla, avisa (warn, sin ids) y sigue con el siguiente backoff, no se rinde', async () => {
        redis.pipe.exec.mockRejectedValue(new Error('sigue caído'));
        await publicarSesionCerrada(['u1'], 'revocada');
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
        expect(redis.pipe.exec).toHaveBeenCalledTimes(2);
        expect(logger.warn.mock.calls.at(-1)?.[1]).toMatchObject({ motivo: 'revocada', personas: 1, intento: 1, error: 'sigue caído' });
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('u1');
        expect(avisosPendientes()).toBe(1);
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]);
        expect(redis.pipe.exec).toHaveBeenCalledTimes(3);
        expect(logger.error).toHaveBeenCalledOnce(); // un solo error hasta que se da por vencido
    });

    it('Redis colgado: la acción sigue terminando a ~1 s (el reintento va aparte)', async () => {
        redis.pipe.exec.mockImplementationOnce(() => new Promise(() => {}));
        let terminada = false;
        const p = publicarSesionCerrada(['u1'], 'baja').then(() => { terminada = true; });
        await vi.advanceTimersByTimeAsync(ESPERA_MAX_MS + 1);
        await p;
        expect(terminada).toBe(true);
        expect(logger.error).toHaveBeenCalledOnce();
    });

    it('el registro lleva ids internos y nada más: ni correo ni token', async () => {
        redis.pipe.exec.mockRejectedValueOnce(new Error('boom'));
        await publicarSesionCerrada(['0192-uuid'], 'baja');
        expect(Object.keys(logger.error.mock.calls[0][1]).sort()).toEqual(['error', 'motivo', 'tipo', 'userIds']);
    });

    it('un aviso que sale bien no deja error ni reintento', async () => {
        await publicarSesionCerrada(['u1'], 'baja');
        await vi.advanceTimersByTimeAsync(REINTENTO_MS * 3);
        expect(logger.error).not.toHaveBeenCalled();
        expect(redis.pipe.exec).toHaveBeenCalledOnce();
    });
});

describe('el cliente de eventos', () => {
    it('lleva un oyente de `error` (sin él ioredis vuelca la traza en cada reconexión) y se crea una sola vez', async () => {
        await publicarSesionCerrada(['u1'], 'logout');
        await publicarSesionCerrada(['u2'], 'logout');
        expect(redis.base.duplicate).toHaveBeenCalledOnce();
        expect(redis.duplicado.on).toHaveBeenCalledOnce();
        expect(redis.duplicado.on).toHaveBeenCalledWith('error', expect.any(Function));
        const alErrar = redis.duplicado.on.mock.calls[0][1] as (e: Error) => void;
        expect(() => alErrar(new Error('ECONNRESET'))).not.toThrow();
        expect(logger.warn).toHaveBeenCalledWith('[eventos-de-sesion] redis', { msg: 'ECONNRESET' });
    });
});

describe('Redis colgado (continuación)', () => {
    it('Redis colgado: la acción termina a ~1 s, no se queda esperando', async () => {
        redis.pipe.exec.mockImplementation(() => new Promise(() => {})); // nunca contesta
        let terminada = false;
        const p = publicarSesionCerrada(['u1'], 'logout').then(() => { terminada = true; });
        await vi.advanceTimersByTimeAsync(ESPERA_MAX_MS - 1);
        expect(terminada).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        await p;
        expect(terminada).toBe(true);
        expect(ESPERA_MAX_MS).toBeLessThanOrEqual(1000);
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe('quién tiene un rol, consultado en el momento', () => {
    it('busca por rol por defecto Y por membresía', async () => {
        db.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
        await expect(personasConRol('rol-1')).resolves.toEqual(['a', 'b']);
        expect(db.user.findMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { defaultRoleId: 'rol-1' },
                    { members: { some: { memberRoles: { some: { roleId: 'rol-1' } } } } },
                ],
            },
            select: { id: true },
        });
    });

    it('si la base falla devuelve vacío y no lanza', async () => {
        db.user.findMany.mockRejectedValue(new Error('db caída'));
        await expect(personasConRol('rol-1')).resolves.toEqual([]);
        db.member.findMany.mockRejectedValue(new Error('db caída'));
        await expect(personasDeLaSucursal('org-1')).resolves.toEqual([]);
    });

    it('con `lanzar: true` (antes de BORRAR) la caída de la base se propaga, para que el borrado aborte', async () => {
        db.user.findMany.mockRejectedValue(new Error('db caída'));
        await expect(personasConRol('rol-1', { lanzar: true })).rejects.toThrow('db caída');
        db.member.findMany.mockRejectedValue(new Error('db caída'));
        await expect(personasDeLaSucursal('org-1', { lanzar: true })).rejects.toThrow('db caída');
    });

    it('con `lanzar: true` y la base viva devuelve lo mismo', async () => {
        db.user.findMany.mockResolvedValue([{ id: 'a' }]);
        db.member.findMany.mockResolvedValue([{ userId: 's1' }]);
        await expect(personasConRol('rol-1', { lanzar: true })).resolves.toEqual(['a']);
        await expect(personasDeLaSucursal('org-1', { lanzar: true })).resolves.toEqual(['s1']);
    });
});
