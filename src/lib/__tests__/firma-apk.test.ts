/**
 * FIRMAR UNA APK DE EXTREMO A EXTREMO (lib/firma-apk.ts) con un keystore DE JUGUETE y las herramientas de verdad
 * (zipalign + apksigner + keytool). Si el equipo no las tiene, esas pruebas se saltan (la imagen de Docker sí las lleva).
 *
 * Lo que se ata: que la APK sale firmada y VERIFICADA por apksigner, que con otra huella esperada NO se entrega nada, que un
 * paquete ajeno no se firma, que el keystore no se queda en disco, que las contraseñas no están en la línea de órdenes de
 * ningún proceso ni en los logs, que el tope de subida corta, y que una segunda firma a la vez se rechaza.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const registro = vi.hoisted(() => ({ lineas: [] as string[] }));
vi.mock('@/lib/logger', () => {
    const anota = (...a: unknown[]) => void registro.lineas.push(JSON.stringify(a));
    return { logger: { info: anota, warn: anota, error: anota, debug: anota } };
});

import { cifrarAlmacen, descifrarAlmacen } from '../firma-apk-clave';
import { ErrorDeFirma } from '../firma-apk-error';
import { leerManifiestoCrudo } from '../firma-apk-manifest';
import { zip } from './helpers/zip-minimo';
import { conDirectorioTemporal, firmarArchivo, guardarSubida, interpretarVerificacion, TOPE_DE_APK, unaFirmaALaVez } from '../firma-apk';
import { crearKeystoreDeJuguete, herramientas, usarHerramientas, type KeystoreDeJuguete } from './helpers/herramientas-de-firma';

const FIXTURES = path.join(__dirname, 'fixtures');
const hay = herramientas().completas;

describe('interpretar la salida de apksigner verify', () => {
    const SALIDA = [
        'Verifies',
        'Verified using v1 scheme (JAR signing): false',
        'Verified using v2 scheme (APK Signature Scheme v2): true',
        'Verified using v3 scheme (APK Signature Scheme v3): true',
        'Verified using v3.1 scheme (APK Signature Scheme v3.1): false',
        'Verified using v4 scheme (APK Signature Scheme v4): false',
        'Number of signers: 1',
        'Signer #1 certificate DN: CN=Procovar',
        'Signer #1 certificate SHA-256 digest: 01529F5A6FB1A238985745AFF13CDCF7E8E85B624992F4E328BDE9898FD80B21',
    ].join('\n');

    it('saca la huella en minúsculas y los esquemas', () => {
        expect(interpretarVerificacion(SALIDA)).toEqual({ huellas: ['01529f5a6fb1a238985745aff13cdcf7e8e85b624992f4e328bde9898fd80b21'], v2: true, v3: true });
    });

    it('v2 o v3 en false se ven como false (no se confunde con la línea de v3.1)', () => {
        const sinV3 = SALIDA.replace('v3 scheme (APK Signature Scheme v3): true', 'v3 scheme (APK Signature Scheme v3): false');
        expect(interpretarVerificacion(sinV3).v3).toBe(false);
        expect(interpretarVerificacion(SALIDA.replace('v2 scheme (APK Signature Scheme v2): true', 'v2 scheme (APK Signature Scheme v2): false')).v2).toBe(false);
    });

    it('varios firmantes salen como varias huellas; sin firmantes, ninguna', () => {
        expect(interpretarVerificacion(`${SALIDA}\nSigner #2 certificate SHA-256 digest: ${'ab'.repeat(32)}`).huellas).toHaveLength(2);
        expect(interpretarVerificacion('DOES NOT VERIFY').huellas).toEqual([]);
    });
});

describe('la subida', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'prueba-subida-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const flujo = (trozos: Uint8Array[]) =>
        new ReadableStream<Uint8Array>({
            pull(c) {
                const t = trozos.shift();
                if (t) c.enqueue(t);
                else c.close();
            },
        });

    it('guarda lo que llega y da su tamaño y su SHA-256', async () => {
        const r = await guardarSubida(flujo([Buffer.from('hola '), Buffer.from('mundo')]), path.join(dir, 'x'), 100);
        expect(r.tamano).toBe(10);
        expect(r.sha256).toBe(createHash('sha256').update('hola mundo').digest('hex'));
        expect((await readFile(path.join(dir, 'x'))).toString()).toBe('hola mundo');
    });

    it('se corta en cuanto pasa del tope, sin pedir el resto del cuerpo', async () => {
        let pedidos = 0;
        const infinito = new ReadableStream<Uint8Array>({
            pull(c) {
                pedidos++;
                c.enqueue(new Uint8Array(1000));
            },
        });
        await expect(guardarSubida(infinito, path.join(dir, 'y'), 5000)).rejects.toMatchObject({ codigo: 'demasiado_grande' });
        expect(pedidos).toBeLessThan(20);
    });

    it('un cuerpo vacío es sin_cuerpo', async () => {
        await expect(guardarSubida(flujo([]), path.join(dir, 'z'))).rejects.toMatchObject({ codigo: 'sin_cuerpo' });
    });

    it('el tope es de 120 MB', () => {
        expect(TOPE_DE_APK).toBe(120 * 1024 * 1024);
    });
});

describe('una firma a la vez', () => {
    it('la segunda mientras la primera sigue se rechaza (429); al acabar se puede otra, también si la primera falló', async () => {
        let soltar!: () => void;
        const primera = unaFirmaALaVez(() => new Promise<void>((r) => (soltar = r)));
        await expect(unaFirmaALaVez(async () => 1)).rejects.toMatchObject({ codigo: 'firma_ocupada', estado: 429 });
        soltar();
        await primera;
        await expect(unaFirmaALaVez(async () => 2)).resolves.toBe(2);
        await expect(unaFirmaALaVez(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        await expect(unaFirmaALaVez(async () => 3)).resolves.toBe(3);
    });

    it('el directorio temporal se borra siempre, también si el trabajo falla', async () => {
        let visto = '';
        await expect(
            conDirectorioTemporal(async (d) => {
                visto = d;
                await writeFile(path.join(d, 'algo'), 'x');
                throw new Error('fallo');
            }),
        ).rejects.toThrow('fallo');
        expect(existsSync(visto)).toBe(false);
    });
});

describe.skipIf(!hay)('firmar de verdad (keytool + zipalign + apksigner)', () => {
    let juguete: KeystoreDeJuguete;
    let raiz: string;
    let dir: string;

    beforeAll(async () => {
        usarHerramientas();
        process.env.SERVICE_AUTH_SECRET = 'prueba-de-firma-'.repeat(4);
        raiz = await mkdtemp(path.join(tmpdir(), 'prueba-firma-juguete-'));
        juguete = crearKeystoreDeJuguete(raiz);
    });
    beforeEach(async () => {
        registro.lineas.length = 0;
        dir = await mkdtemp(path.join(tmpdir(), 'prueba-firma-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** El almacén tal como lo entrega `cargarAlmacen()`: pasa por cifrar y descifrar de verdad. */
    const almacen = async () => descifrarAlmacen(cifrarAlmacen({ keystoreB64: (await readFile(juguete.ruta)).toString('base64'), claveAlmacen: juguete.claveAlmacen, claveAlias: juguete.claveAlias }, juguete.huella), juguete.huella);
    const poner = (fixture: string) => {
        const entrada = path.join(dir, 'entrada.apk');
        copyFileSync(path.join(FIXTURES, fixture), entrada);
        return entrada;
    };

    it('la firma, apksigner la verifica y el certificado es el del juguete', async () => {
        const entrada = poner('reparto-sin-firmar.apk');
        const r = await firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella });
        expect(r.manifiesto).toEqual({ paquete: 'cloud.procovar.reparto', versionName: '1.2.3', versionCode: '45' });
        expect(r.tamano).toBeGreaterThan(0);

        // Verificación INDEPENDIENTE del código que se prueba: apksigner directamente sobre el fichero entregado.
        const salida = execFileSync(process.env.APKSIGNER!, ['verify', '--verbose', '--print-certs', r.rutaFirmada], { stdio: 'pipe' }).toString();
        expect(salida).toMatch(/Verified using v2 scheme \(APK Signature Scheme v2\): true/);
        expect(salida).toMatch(/Verified using v3 scheme \(APK Signature Scheme v3\): true/);
        expect(salida.toLowerCase()).toContain(juguete.huella);
        expect(r.sha256Salida).toMatch(/^[0-9a-f]{64}$/);
    });

    it('una APK sin alinear se alinea antes de firmar (Android 11+ no instala resources.arsc sin alinear)', async () => {
        const axml = await leerManifiestoCrudo(path.join(FIXTURES, 'reparto-sin-firmar.apk'));
        // Entradas SIN comprimir con un nombre de largo impar: sus datos caen en desplazamientos que no son múltiplos de 4.
        const entrada = path.join(dir, 'entrada.apk');
        await writeFile(entrada, zip([{ nombre: 'AndroidManifest.xml', datos: axml }, { nombre: 'resources.arsc', datos: Buffer.alloc(33, 7) }]));
        const alineada = (f: string) => {
            try {
                execFileSync(process.env.ZIPALIGN!, ['-c', '4', f], { stdio: 'pipe' });
                return true;
            } catch {
                return false;
            }
        };
        expect(alineada(entrada)).toBe(false); // el punto de partida es de verdad una APK sin alinear
        const r = await firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella });
        expect(alineada(r.rutaFirmada)).toBe(true);
    });

    it('si el certificado NO es el esperado (la huella de la casa) no se entrega nada: huella_distinta', async () => {
        const entrada = poner('reparto-sin-firmar.apk');
        await expect(
            firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64) /* huella esperada: la REAL de la casa */ }),
        ).rejects.toMatchObject({ codigo: 'huella_distinta' });
    });

    it('una APK de otro paquete no se firma, y ni se llega a abrir el keystore', async () => {
        const entrada = poner('ajena-sin-firmar.apk');
        await expect(
            firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella }),
        ).rejects.toMatchObject({ codigo: 'paquete_no_permitido' });
        expect((await readdir(dir)).filter((f) => f.startsWith('firmada-') || f.startsWith('ks-'))).toEqual([]);
    });

    it('la APK de Reparto no se firma como si fuera de Transferencias (el desplegable mal elegido)', async () => {
        const entrada = poner('reparto-sin-firmar.apk');
        await expect(
            firmarArchivo({ dir, entrada, clientId: 'transferencias-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella }),
        ).rejects.toMatchObject({ codigo: 'paquete_no_permitido' });
    });

    it('un fichero que no es APK se rechaza antes de lanzar nada', async () => {
        const entrada = path.join(dir, 'entrada.apk');
        await writeFile(entrada, 'esto es un texto cualquiera '.repeat(10));
        await expect(
            firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella }),
        ).rejects.toMatchObject({ codigo: 'apk_invalida' });
    });

    it('una contraseña de clave equivocada falla como firma_fallida, sin filtrar nada', async () => {
        const entrada = poner('reparto-sin-firmar.apk');
        const malo = { ...(await almacen()), claveAlias: 'la-contrasena-que-no-es' };
        const e = await firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: malo, sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella }).then(() => null, (x: unknown) => x);
        expect(e).toBeInstanceOf(ErrorDeFirma);
        expect((e as ErrorDeFirma).codigo).toBe('firma_fallida');
        expect((e as Error).message).not.toContain(dir);
        expect(registro.lineas.join('\n')).not.toContain('la-contrasena-que-no-es');
    });

    it('el keystore NO se queda en disco, y las contraseñas no salen en ningún log', async () => {
        const entrada = poner('reparto-sin-firmar.apk');
        const a = await almacen();
        await firmarArchivo({ dir, entrada, clientId: 'delivery-apk', alias: juguete.alias, almacen: a, sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella });
        expect(readdirSync(dir).filter((f) => f.startsWith('ks-'))).toEqual([]);
        const logs = registro.lineas.join('\n');
        expect(logs).not.toContain(a.claveAlmacen);
        expect(logs).not.toContain(a.claveAlias);
    });

    it('apksigner no recibe las contraseñas en su línea de órdenes (van por entorno)', async () => {
        // Se sustituye apksigner por un envoltorio que vuelca sus argumentos y luego llama al verdadero.
        const real = process.env.APKSIGNER!;
        const volcado = path.join(dir, 'argumentos.txt');
        const envoltorio = path.join(dir, 'apksigner-espia.sh');
        await writeFile(envoltorio, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${volcado}'\nexec '${real}' "$@"\n`, { mode: 0o700 });
        process.env.APKSIGNER = envoltorio;
        try {
            const a = await almacen();
            await firmarArchivo({ dir, entrada: poner('reparto-sin-firmar.apk'), clientId: 'delivery-apk', alias: juguete.alias, almacen: a, sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella });
            const argumentos = await readFile(volcado, 'utf8');
            expect(argumentos).toContain('env:FIRMA_CLAVE_ALMACEN');
            expect(argumentos).not.toContain(a.claveAlmacen);
            expect(argumentos).not.toContain(a.claveAlias);
        } finally {
            process.env.APKSIGNER = real;
        }
    });

    it('si apksigner no existe es herramienta_no_disponible (no un 500 con la ruta)', async () => {
        const real = process.env.APKSIGNER!;
        process.env.APKSIGNER = '/no/existe/apksigner';
        try {
            await expect(
                firmarArchivo({ dir, entrada: poner('reparto-sin-firmar.apk'), clientId: 'delivery-apk', alias: juguete.alias, almacen: await almacen(), sha256Entrada: 'e'.repeat(64), huellaEsperada: juguete.huella }),
            ).rejects.toMatchObject({ codigo: 'herramienta_no_disponible' });
        } finally {
            process.env.APKSIGNER = real;
        }
    });
});
