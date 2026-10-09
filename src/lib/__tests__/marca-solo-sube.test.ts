/**
 * La marca `procovar:auth:invalida:*` sólo SUBE (B2 de la auditoría 08/10/2026): un aviso tardío o
 * reintentado no puede hacerla retroceder. El script Lua sólo se puede probar contra un Redis de
 * verdad, así que esta suite corre SI hay uno: `REDIS_DE_PRUEBA=redis://127.0.0.1:6379 npx vitest run`
 * (p. ej. `docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine`). Sin la variable se salta.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';

const url = process.env.REDIS_DE_PRUEBA;
const real = vi.hoisted(() => ({ cliente: undefined as unknown }));
vi.mock('@/lib/redis', () => ({
    getRedis: () => ({ duplicate: () => real.cliente }),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { publicarSesionCerrada, claveDeMarca } from '../eventos-de-sesion';

describe.skipIf(!url)('marca de invalidación contra un Redis real', () => {
    let cliente: Redis;
    beforeAll(() => {
        cliente = new Redis(url as string);
        real.cliente = cliente;
    });
    afterAll(async () => { await cliente.quit(); });
    beforeEach(async () => {
        globalThis.__procovarEventosRedis = undefined;
        await cliente.flushdb();
        vi.useRealTimers();
    });

    it('sin marca previa: la escribe, con TTL de 8 días', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2_000_000_000_000);
        await publicarSesionCerrada(['u1'], 'baja');
        expect(await cliente.get(claveDeMarca('todo', 'u1'))).toBe('2000000000000');
        expect(await cliente.ttl(claveDeMarca('todo', 'u1'))).toBeGreaterThan(691_000);
    });

    it('un aviso con tms MENOR no la baja (era el defecto: SET sin comparar)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(2_000_000_000_000);
        await publicarSesionCerrada(['u1'], 'baja');
        vi.setSystemTime(1_999_999_999_000);
        await publicarSesionCerrada(['u1'], 'revocada');
        expect(await cliente.get(claveDeMarca('todo', 'u1'))).toBe('2000000000000');
    });

    it('uno MAYOR sí la sube, y el mismo tms la deja igual', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(2_000_000_000_000);
        await publicarSesionCerrada(['u1'], 'baja');
        await publicarSesionCerrada(['u1'], 'baja');
        expect(await cliente.get(claveDeMarca('todo', 'u1'))).toBe('2000000000000');
        vi.setSystemTime(2_000_000_005_000);
        await publicarSesionCerrada(['u1'], 'baja');
        expect(await cliente.get(claveDeMarca('todo', 'u1'))).toBe('2000000005000');
    });

    it('la marca web y la todo son independientes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(2_000_000_000_000);
        await publicarSesionCerrada(['u1'], 'baja');
        vi.setSystemTime(1_000_000_000_000);
        await publicarSesionCerrada(['u1'], 'logout');
        expect(await cliente.get(claveDeMarca('web', 'u1'))).toBe('1000000000000');
        expect(await cliente.get(claveDeMarca('todo', 'u1'))).toBe('2000000000000');
    });

    it('una marca corrupta (no numérica) se pisa en vez de bloquear para siempre', async () => {
        await cliente.set(claveDeMarca('todo', 'u1'), 'basura');
        await publicarSesionCerrada(['u1'], 'baja');
        expect(Number(await cliente.get(claveDeMarca('todo', 'u1')))).toBeGreaterThan(1e12);
    });

    it('el mensaje sigue llegando a los suscriptores (con el pipeline de verdad)', async () => {
        const suscriptor = new Redis(url as string);
        const recibidos: string[] = [];
        suscriptor.on('message', (_c, m) => recibidos.push(m));
        await suscriptor.subscribe('procovar:auth:eventos');
        await publicarSesionCerrada(['u1', 'u2'], 'baja');
        await new Promise((r) => setTimeout(r, 100));
        await suscriptor.quit();
        expect(recibidos.map((m) => JSON.parse(m))).toEqual([
            expect.objectContaining({ v: 1, tipo: 'sesion-cerrada', userIds: ['u1', 'u2'], motivo: 'baja', alcance: 'todo' }),
        ]);
    });
});
