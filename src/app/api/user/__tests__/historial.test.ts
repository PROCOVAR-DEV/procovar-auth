/**
 * GET /api/user/historial vista desde fuera: sesión obligatoria, la persona sale de la cookie
 * (nunca de la petición), el tope se aplica y un cursor roto es un 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sesion = vi.hoisted(() => ({ resolveSessionUser: vi.fn() }));
const datos = vi.hoisted(() => ({ historialDeInicios: vi.fn() }));
vi.mock('@/lib/require-admin', () => sesion);
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/historial-de-inicios', async (original) => ({
    ...(await original<typeof import('@/lib/historial-de-inicios')>()),
    historialDeInicios: datos.historialDeInicios,
}));

import { GET } from '../historial/route';

const pedir = (query = '') => GET(new Request(`http://localhost:3500/api/user/historial${query}`));

beforeEach(() => {
    vi.clearAllMocks();
    sesion.resolveSessionUser.mockResolvedValue({ user: { id: 'ana' }, session: { id: 's-ana' } });
    datos.historialDeInicios.mockResolvedValue({ filas: [], siguiente: null });
});

describe('/api/user/historial', () => {
    it('sin sesión: 401 y no se lee nada', async () => {
        sesion.resolveSessionUser.mockResolvedValue(null);
        const res = await pedir();
        expect(res.status).toBe(401);
        expect(datos.historialDeInicios).not.toHaveBeenCalled();
    });

    it('la persona es la de la sesión: ?userId= de la petición se ignora', async () => {
        const res = await pedir('?userId=beto&user=beto&id=beto');
        expect(res.status).toBe(200);
        expect(datos.historialDeInicios).toHaveBeenCalledWith('ana', expect.objectContaining({ sesionActualId: 's-ana' }));
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('el límite se recorta a 50 y por defecto es 10', async () => {
        await pedir('?limite=100000');
        expect(datos.historialDeInicios.mock.calls[0][1].limite).toBe(50);
        await pedir();
        expect(datos.historialDeInicios.mock.calls[1][1].limite).toBe(10);
    });

    it('desde llega como fecha; uno roto es 400', async () => {
        await pedir('?desde=2026-10-01T10:00:00.000Z');
        expect(datos.historialDeInicios.mock.calls[0][1].desde).toEqual(new Date('2026-10-01T10:00:00.000Z'));
        const mal = await pedir('?desde=ayer');
        expect(mal.status).toBe(400);
        expect(datos.historialDeInicios).toHaveBeenCalledTimes(1);
    });

    it('si la lectura falla: 500 sin detalles', async () => {
        datos.historialDeInicios.mockRejectedValue(new Error('la base se cayó con datos internos'));
        const res = await pedir();
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'internal_error' });
    });
});
