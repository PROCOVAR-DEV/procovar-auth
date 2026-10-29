/**
 * LA IMPORTACIÓN ÚNICA DE LA CLAVE (lib/firma-apk-importar.ts y scripts/importar-clave-de-firma.ts). Con un keystore de juguete:
 * la clave real de la casa no se toca en ninguna prueba.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspeccionarKeystore, leerClaves } from '../firma-apk-importar';
import { crearKeystoreDeJuguete, herramientas, usarHerramientas, type KeystoreDeJuguete } from './helpers/herramientas-de-firma';

describe('el fichero de contraseñas', () => {
    it('formato CLAVE_ALMACEN= / CLAVE_ALIAS= / ALIAS= (el de firma-apk-reparto.txt), ignorando lo demás', () => {
        const r = leerClaves(['ALMACEN=procovar-reparto.jks', 'ALIAS=reparto', 'CLAVE_ALMACEN=alm-1', 'CLAVE_ALIAS=ali-2', '', '# Se comprueba con apksigner', 'CERT_SHA256=00:11', 'CERT_DN=CN=x, O=y'].join('\n'));
        expect(r).toEqual({ claveAlmacen: 'alm-1', claveAlias: 'ali-2', alias: 'reparto' });
    });

    it('formato «clave: …» (una contraseña para las dos cosas), con CRLF y comillas', () => {
        expect(leerClaves('fichero: reparto-firma.jks\r\nalias: reparto\r\nalgoritmo: RSA\r\nclave: "una-clave"\r\n')).toEqual({ claveAlmacen: 'una-clave', claveAlias: 'una-clave', alias: 'reparto' });
    });

    it('una sola línea es la contraseña de las dos', () => {
        expect(leerClaves('solo-la-clave\n')).toEqual({ claveAlmacen: 'solo-la-clave', claveAlias: 'solo-la-clave', alias: null });
    });

    it('sin contraseña, falla sin repetir el contenido del fichero', () => {
        expect(() => leerClaves('# nada\nALIAS=x\n')).toThrowError(/contraseña del almacén/);
        try {
            leerClaves('ALIAS=secreto-que-no-debe-salir');
        } catch (e) {
            expect((e as Error).message).not.toContain('secreto-que-no-debe-salir');
        }
    });
});

describe.skipIf(!herramientas().keytool)('abrir un keystore con keytool', () => {
    let raiz: string;
    let juguete: KeystoreDeJuguete;
    beforeAll(async () => {
        usarHerramientas();
        raiz = await mkdtemp(path.join(tmpdir(), 'prueba-importar-'));
        juguete = crearKeystoreDeJuguete(raiz);
    });
    afterAll(async () => {
        await rm(raiz, { recursive: true, force: true });
    });

    it('da el alias, la huella (la misma que calcula aparte el ayudante) y los datos públicos', async () => {
        const k = await inspeccionarKeystore({ jks: juguete.ruta, claves: { claveAlmacen: juguete.claveAlmacen, claveAlias: juguete.claveAlias, alias: null } });
        expect(k.alias).toBe('juguete');
        expect(k.huella).toBe(juguete.huella);
        expect(k.sujeto).toBe('CN=Juguete Procovar, O=Pruebas');
        expect(k.validoHasta.getTime()).toBeGreaterThan(k.validoDesde.getTime());
    });

    it('contraseña del almacén equivocada: error claro, sin la contraseña ni su longitud', async () => {
        const e = await inspeccionarKeystore({ jks: juguete.ruta, claves: { claveAlmacen: 'mala-mala-mala', claveAlias: juguete.claveAlias, alias: null } }).then(() => null, (x: unknown) => x as Error);
        expect(e?.message).toMatch(/almacén/);
        expect(e?.message).not.toContain('mala-mala-mala');
    });

    it('contraseña de la CLAVE equivocada (la del almacén bien): se detecta ya, no al firmar', async () => {
        await expect(inspeccionarKeystore({ jks: juguete.ruta, claves: { claveAlmacen: juguete.claveAlmacen, claveAlias: 'otra-distinta', alias: null } })).rejects.toThrow(/CLAVE_ALIAS/);
    });

    it('un alias que no existe', async () => {
        await expect(inspeccionarKeystore({ jks: juguete.ruta, claves: { claveAlmacen: juguete.claveAlmacen, claveAlias: juguete.claveAlias, alias: 'otro' } })).rejects.toThrow(/alias/);
    });

    it('un fichero que no es un keystore', async () => {
        const falso = path.join(raiz, 'falso.jks');
        await writeFile(falso, 'no soy un keystore');
        await expect(inspeccionarKeystore({ jks: falso, claves: { claveAlmacen: 'x', claveAlias: 'x', alias: null } })).rejects.toThrow(/almacén/);
    });

    it('EL SCRIPT se niega si la huella no es la de la casa (aquí: el juguete) y no imprime contraseñas', async () => {
        const claves = path.join(raiz, 'claves.txt');
        await writeFile(claves, `ALIAS=juguete\nCLAVE_ALMACEN=${juguete.claveAlmacen}\nCLAVE_ALIAS=${juguete.claveAlias}\n`);
        const r = spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/importar-clave-de-firma.ts', '--jks', juguete.ruta, '--claves', claves, '--solo-comprobar'], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: 'postgresql://nadie:nadie@127.0.0.1:1/nada' },
            timeout: 60_000,
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/NO importada/);
        expect(r.stderr).toContain(juguete.huella); // la huella es pública y ayuda a ver qué fichero era
        const todo = r.stdout + r.stderr;
        expect(todo).not.toContain(juguete.claveAlmacen);
        expect(todo).not.toContain(juguete.claveAlias);
    });

    it('el script sin argumentos explica el uso y sale con 2', () => {
        const r = spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/importar-clave-de-firma.ts'], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: 'postgresql://nadie:nadie@127.0.0.1:1/nada' },
            timeout: 60_000,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/uso:/);
    });
});
