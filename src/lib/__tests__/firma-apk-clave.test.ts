/**
 * LA CLAVE DE FIRMA CIFRADA EN LA BASE (lib/firma-apk-clave.ts): AES-256-GCM con la llave derivada por HKDF de SERVICE_AUTH_SECRET.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({ claveDeFirmaApk: { findUnique: vi.fn() } }));
vi.mock('@/lib/prisma', () => ({ prisma: db }));

import { cargarAlmacen, cifrarAlmacen, datosPublicos, descifrarAlmacen, HUELLA_DE_LA_CASA, type AlmacenDeClaves } from '../firma-apk-clave';
import { ErrorDeFirma } from '../firma-apk-error';

const SECRETO = 'x'.repeat(40);
const ALMACEN: AlmacenDeClaves = { keystoreB64: Buffer.from('un keystore cualquiera').toString('base64'), claveAlmacen: 'contrasena-del-almacen-ZZ', claveAlias: 'contrasena-de-la-clave-YY' };
const HUELLA = 'ab'.repeat(32);

const antes = process.env.SERVICE_AUTH_SECRET;
beforeEach(() => {
    process.env.SERVICE_AUTH_SECRET = SECRETO;
    vi.resetAllMocks();
});
afterEach(() => {
    if (antes === undefined) delete process.env.SERVICE_AUTH_SECRET;
    else process.env.SERVICE_AUTH_SECRET = antes;
});

describe('cifrar y descifrar', () => {
    it('da de vuelta lo mismo, y lo cifrado no deja ver ni el keystore ni las contraseñas', () => {
        const bloque = cifrarAlmacen(ALMACEN, HUELLA);
        expect(descifrarAlmacen(bloque, HUELLA)).toEqual(ALMACEN);
        const texto = bloque.toString('latin1') + bloque.toString('base64') + bloque.toString('hex');
        for (const secreto of [ALMACEN.claveAlmacen, ALMACEN.claveAlias, ALMACEN.keystoreB64, 'un keystore']) expect(texto).not.toContain(secreto);
    });

    it('cada cifrado lleva un IV nuevo: el mismo contenido no da el mismo bloque', () => {
        expect(cifrarAlmacen(ALMACEN, HUELLA).equals(cifrarAlmacen(ALMACEN, HUELLA))).toBe(false);
    });

    it('tocar un solo byte del bloque lo invalida (GCM autentica)', () => {
        const bloque = cifrarAlmacen(ALMACEN, HUELLA);
        for (const i of [0, 12, 27, 28, bloque.length - 1]) {
            const roto = Buffer.from(bloque);
            roto[i] ^= 1;
            expect(() => descifrarAlmacen(roto, HUELLA)).toThrowError(ErrorDeFirma);
        }
    });

    it('cambiar la huella de la fila sin la clave lo invalida (va como dato autenticado)', () => {
        expect(() => descifrarAlmacen(cifrarAlmacen(ALMACEN, HUELLA), 'cd'.repeat(32))).toThrowError(ErrorDeFirma);
    });

    it('con otro SERVICE_AUTH_SECRET no se puede descifrar: clave_ilegible, sin más detalle', () => {
        const bloque = cifrarAlmacen(ALMACEN, HUELLA);
        process.env.SERVICE_AUTH_SECRET = 'y'.repeat(40);
        try {
            descifrarAlmacen(bloque, HUELLA);
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(ErrorDeFirma);
            expect((e as ErrorDeFirma).codigo).toBe('clave_ilegible');
            expect((e as Error).message).not.toMatch(/GCM|auth|tag|decrypt/i);
        }
    });

    it('sin SERVICE_AUTH_SECRET (o demasiado corto) ni cifra ni descifra', () => {
        const bloque = cifrarAlmacen(ALMACEN, HUELLA);
        for (const malo of [undefined, '', 'corto']) {
            if (malo === undefined) delete process.env.SERVICE_AUTH_SECRET;
            else process.env.SERVICE_AUTH_SECRET = malo;
            expect(() => cifrarAlmacen(ALMACEN, HUELLA)).toThrowError(ErrorDeFirma);
            expect(() => descifrarAlmacen(bloque, HUELLA)).toThrowError(ErrorDeFirma);
        }
    });

    it('un bloque corto, vacío o con JSON de otra forma es clave_ilegible', () => {
        expect(() => descifrarAlmacen(new Uint8Array(0), HUELLA)).toThrowError(ErrorDeFirma);
        expect(() => descifrarAlmacen(new Uint8Array(20), HUELLA)).toThrowError(ErrorDeFirma);
        const otraForma = cifrarAlmacen({ keystoreB64: 'x' } as AlmacenDeClaves, HUELLA);
        expect(() => descifrarAlmacen(otraForma, HUELLA)).toThrowError(ErrorDeFirma);
    });
});

describe('lo que sale de la base', () => {
    it('la huella de la casa es la que dijo Jose', () => {
        expect(HUELLA_DE_LA_CASA).toBe('01529f5a6fb1a238985745aff13cdcf7e8e85b624992f4e328bde9898fd80b21');
    });

    it('datosPublicos() pide solo los campos públicos: la columna cifrada ni se lee', async () => {
        const ahora = new Date();
        db.claveDeFirmaApk.findUnique.mockResolvedValue({ huella: HUELLA, sujeto: 'CN=Procovar', validoDesde: ahora, validoHasta: ahora, alias: 'a', updatedAt: ahora });
        const d = await datosPublicos();
        expect(d).toEqual({ huella: HUELLA, sujeto: 'CN=Procovar', validoDesde: ahora, validoHasta: ahora, alias: 'a', importadaEl: ahora });
        const consulta = db.claveDeFirmaApk.findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
        expect(consulta.select).toBeDefined();
        expect(consulta.select.cifrado).toBeUndefined();
        expect(JSON.stringify(d)).not.toMatch(/cifrado|clave(Almacen|Alias)|keystore/i);
    });

    it('datosPublicos() es null si aún no se importó', async () => {
        db.claveDeFirmaApk.findUnique.mockResolvedValue(null);
        expect(await datosPublicos()).toBeNull();
    });

    it('cargarAlmacen() descifra la fila; sin fila es sin_clave', async () => {
        db.claveDeFirmaApk.findUnique.mockResolvedValue({ huella: HUELLA, alias: 'a', cifrado: cifrarAlmacen(ALMACEN, HUELLA) });
        expect((await cargarAlmacen()).almacen).toEqual(ALMACEN);
        db.claveDeFirmaApk.findUnique.mockResolvedValue(null);
        await expect(cargarAlmacen()).rejects.toMatchObject({ codigo: 'sin_clave' });
    });
});
