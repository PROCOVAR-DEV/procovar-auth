/**
 * EL REGISTRO DE DISPOSITIVOS (docs/dispositivos.md, 29/10/2026).
 *
 * Lo que se ata aquí: que la identidad se lee de las cabeceras y del User-Agent, que el registro NUNCA rompe la
 * renovación (una caída de la base no puede salir como 401 ni 500), que el bloqueo falla ABIERTO, que el estado
 * que informa un aparato se limpia, y que la marca (funciona / atascado / callado) dice la verdad.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
    dispositivo: { upsert: vi.fn(), findUnique: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: db }));

import {
    delTokenRecienFirmado,
    dispositivoBloqueado,
    HORAS_DE_UN_ERROR,
    HORAS_PARA_ATASCADO,
    HORAS_PARA_CALLADO,
    leerCabecerasDeAparato,
    leerEstadoInformado,
    limpiarTexto,
    marcaDelDispositivo,
    partesDelAgente,
    registrarDispositivo,
    type DeLaMarca,
} from '../dispositivos';

const ID = '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10';

describe('las cabeceras del aparato', () => {
    it('lee el id (en minúsculas) y el nombre del equipo', () => {
        const h = new Headers({ 'x-aparato-id': ID.toUpperCase(), 'x-aparato-nombre': '  Samsung   A14 de Palma ' });
        expect(leerCabecerasDeAparato(h)).toEqual({ aparatoId: ID, esV7: true, equipo: 'Samsung A14 de Palma' });
    });

    it('un id que no es un UUID NO registra nada (el aparato sigue funcionando igual)', () => {
        for (const malo of ['', 'abc', '../../etc/passwd', ID + 'x', "'; DROP TABLE dispositivo;--"]) {
            expect(leerCabecerasDeAparato(new Headers({ 'x-aparato-id': malo })).aparatoId).toBeNull();
        }
        expect(leerCabecerasDeAparato(new Headers()).aparatoId).toBeNull();
    });

    it('un v4 se lee pero NO es v7: solo podrá actualizar un aparato que ya exista (el importado), nunca crear uno', () => {
        const v4 = leerCabecerasDeAparato(new Headers({ 'x-aparato-id': '0f4c9c1e-8a3b-4d0e-9d62-6a1f3b6f2c10' }));
        expect(v4).toMatchObject({ aparatoId: '0f4c9c1e-8a3b-4d0e-9d62-6a1f3b6f2c10', esV7: false });
    });

    it('el nombre del equipo se limpia y se recorta', () => {
        expect(limpiarTexto('a\u0000b\nc', 80)).toBe('a b c');
        expect(limpiarTexto('x'.repeat(200), 80)).toHaveLength(80);
        expect(limpiarTexto('   ', 80)).toBeNull();
        expect(limpiarTexto(42, 80)).toBeNull();
    });
});

describe('el User-Agent', () => {
    it('saca aplicación, versión y plataforma', () => {
        expect(partesDelAgente('ProcovarReparto/1.0.47 (Windows)')).toEqual({
            aplicacion: 'ProcovarReparto',
            version: '1.0.47',
            plataforma: 'Windows',
        });
        expect(partesDelAgente('ProcovarCRM/2.3.1+48 (Android)').version).toBe('2.3.1+48');
    });
    it('un navegador o nada no rompen: todo nulo', () => {
        expect(partesDelAgente('Mozilla/5.0 (X11; Linux x86_64) Gecko/2010').aplicacion).toBe('Mozilla');
        expect(partesDelAgente(null)).toEqual({ aplicacion: null, version: null, plataforma: null });
        expect(partesDelAgente('')).toEqual({ aplicacion: null, version: null, plataforma: null });
    });
});

describe('el token recién firmado', () => {
    const token = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.y`;
    it('da la persona, la aplicación y la sucursal', () => {
        expect(delTokenRecienFirmado(token({ sub: 'u1', azp: 'delivery-apk', sucursal: 'STG' }))).toEqual({
            sub: 'u1', azp: 'delivery-apk', sucursal: 'STG',
        });
        expect(delTokenRecienFirmado(token({ sub: 'u1', azp: 'crm-apk', sucursal: '' }))?.sucursal).toBeNull();
    });
    it('basura = null, nunca una excepción', () => {
        expect(delTokenRecienFirmado('')).toBeNull();
        expect(delTokenRecienFirmado('a.b.c')).toBeNull();
        expect(delTokenRecienFirmado(token({ sub: 'u1' }))).toBeNull();
    });
});

describe('registrarDispositivo: nunca rompe la renovación', () => {
    beforeEach(() => vi.clearAllMocks());
    const datos = {
        userId: 'u1', clientId: 'delivery-apk', aparatoId: ID, equipo: 'PC de Maikel', sucursal: 'STG',
        ip: '1.2.3.4', userAgent: 'ProcovarReparto/1.0.47 (Windows)', familyId: 'fam1',
    };

    it('crea o actualiza con la versión y la plataforma de AHORA', async () => {
        db.dispositivo.upsert.mockResolvedValue({});
        expect(await registrarDispositivo(datos)).toBe(true);
        const arg = db.dispositivo.upsert.mock.calls[0][0];
        expect(arg.where).toEqual({ clientId_aparatoId: { clientId: 'delivery-apk', aparatoId: ID } });
        expect(arg.update).toMatchObject({ version: '1.0.47', plataforma: 'Windows', userId: 'u1', equipo: 'PC de Maikel', familyId: 'fam1' });
        expect(arg.create).toMatchObject({ userId: 'u1', aparatoId: ID, version: '1.0.47' });
    });

    it('sin nombre de equipo NO pisa el que ya tenía, y el nombre de un administrador nunca se toca', async () => {
        db.dispositivo.upsert.mockResolvedValue({});
        await registrarDispositivo({ ...datos, equipo: null });
        const arg = db.dispositivo.upsert.mock.calls[0][0];
        expect(arg.update).not.toHaveProperty('equipo');
        expect(arg.update).not.toHaveProperty('nombre');
    });

    it('si la base falla, devuelve false y NO lanza', async () => {
        db.dispositivo.upsert.mockRejectedValue(new Error('base caída'));
        await expect(registrarDispositivo(datos)).resolves.toBe(false);
    });
});

describe('dispositivoBloqueado: falla ABIERTO', () => {
    beforeEach(() => vi.clearAllMocks());
    it('bloqueado solo si un administrador lo bloqueó', async () => {
        db.dispositivo.findUnique.mockResolvedValue({ bloqueadoAt: new Date() });
        expect(await dispositivoBloqueado('delivery-apk', ID)).toBe(true);
        db.dispositivo.findUnique.mockResolvedValue({ bloqueadoAt: null });
        expect(await dispositivoBloqueado('delivery-apk', ID)).toBe(false);
        db.dispositivo.findUnique.mockResolvedValue(null);
        expect(await dispositivoBloqueado('delivery-apk', ID)).toBe(false);
    });
    it('si no se puede mirar, NO se bloquea a nadie por una caída', async () => {
        db.dispositivo.findUnique.mockRejectedValue(new Error('base caída'));
        expect(await dispositivoBloqueado('delivery-apk', ID)).toBe(false);
    });
});

describe('el estado que informa el aparato', () => {
    it('acepta lo bueno y lo limpia', () => {
        const e = leerEstadoInformado({
            ultimaDescarga: '2026-10-29T14:02:11Z', ultimaSubida: '2026-10-29T14:02:15Z',
            pendientes: 3, rechazados: 0, ultimoError: '  falló\nla subida ',
        });
        expect(e.ultimaDescarga).toEqual(new Date('2026-10-29T14:02:11Z'));
        expect(e).toMatchObject({ pendientes: 3, rechazados: 0, ultimoError: 'falló la subida' });
    });
    it('un campo ausente NO aparece (no borra lo anterior); null en el error SÍ (ya no hay error)', () => {
        expect(leerEstadoInformado({})).toEqual({});
        expect(leerEstadoInformado({ ultimoError: null })).toEqual({ ultimoError: null });
    });
    it('rechaza lo absurdo: negativos, no enteros, fechas del futuro o de antes de las apps, tipos raros', () => {
        const futuro = new Date(Date.now() + 86_400_000).toISOString();
        expect(leerEstadoInformado({ pendientes: -1, rechazados: 1.5, ultimaSubida: futuro, ultimaDescarga: '2001-01-01T00:00:00Z' })).toEqual({});
        expect(leerEstadoInformado({ pendientes: '3', ultimoError: 42 })).toEqual({});
        expect(leerEstadoInformado(null)).toEqual({});
        expect(leerEstadoInformado('x')).toEqual({});
    });
    it('el error se recorta a 200 caracteres', () => {
        expect(leerEstadoInformado({ ultimoError: 'e'.repeat(500) }).ultimoError).toHaveLength(200);
    });
});

describe('la marca: ¿funciona?', () => {
    const ahora = new Date('2026-10-29T18:00:00Z');
    const hace = (h: number) => new Date(ahora.getTime() - h * 3_600_000);
    const base: DeLaMarca = {
        vistoAt: hace(1), bloqueadoAt: null, ultimaSubida: hace(1), pendientes: 0, rechazados: 0, ultimoError: null, estadoAt: hace(1),
    };

    it('funciona: se ve, informa y no tiene nada', () => expect(marcaDelDispositivo(base, ahora)).toBe('funciona'));
    it('bloqueado manda sobre todo', () =>
        expect(marcaDelDispositivo({ ...base, bloqueadoAt: hace(1), vistoAt: hace(500) }, ahora)).toBe('bloqueado'));
    it('callado: no se ve desde hace días (un día sin señal en Cuba no cuenta)', () => {
        expect(marcaDelDispositivo({ ...base, vistoAt: hace(HORAS_PARA_CALLADO - 1) }, ahora)).toBe('funciona');
        expect(marcaDelDispositivo({ ...base, vistoAt: hace(HORAS_PARA_CALLADO) }, ahora)).toBe('callado');
    });
    it('atascado: rechazados, o pendientes sin subir desde hace horas, o un error reciente', () => {
        expect(marcaDelDispositivo({ ...base, rechazados: 2 }, ahora)).toBe('atascado');
        expect(marcaDelDispositivo({ ...base, pendientes: 5, ultimaSubida: hace(HORAS_PARA_ATASCADO + 1) }, ahora)).toBe('atascado');
        expect(marcaDelDispositivo({ ...base, pendientes: 5, ultimaSubida: null }, ahora)).toBe('atascado');
        expect(marcaDelDispositivo({ ...base, ultimoError: 'timeout' }, ahora)).toBe('atascado');
    });
    it('pendientes con una subida reciente NO es atascado (está trabajando)', () =>
        expect(marcaDelDispositivo({ ...base, pendientes: 5, ultimaSubida: hace(1) }, ahora)).toBe('funciona'));
    it('un error viejo ya no cuenta', () =>
        expect(marcaDelDispositivo({ ...base, ultimoError: 'timeout', estadoAt: hace(HORAS_DE_UN_ERROR + 1) }, ahora)).toBe('funciona'));
    it('sin estado informado NO se dice que funcione', () =>
        expect(marcaDelDispositivo({ ...base, estadoAt: null }, ahora)).toBe('sin_estado'));
});
