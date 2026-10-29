/**
 * LEER EL `package` DE UNA APK SIN EJECUTARLA (lib/firma-apk-manifest.ts).
 *
 * Los dos APK de `fixtures/` son REALES: los fabricó `aapt2 link` (build-tools 35) a partir de un AndroidManifest.xml, así que
 * su manifiesto es el AXML binario de verdad y no uno que el propio parser se inventó. Los casos malos se arman a mano.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leerManifiestoCrudo, leerManifiestoDeApk, interpretarManifiesto } from '../firma-apk-manifest';
import { ErrorDeFirma } from '../firma-apk-error';
import { zip } from './helpers/zip-minimo';

const FIXTURES = path.join(__dirname, 'fixtures');

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'prueba-manifest-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function apk(nombre: string, contenido: Buffer): Promise<string> {
    const ruta = path.join(dir, nombre);
    await writeFile(ruta, contenido);
    return ruta;
}

const rechaza = async (p: Promise<unknown>, codigo = 'apk_invalida') => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorDeFirma);
    expect((e as ErrorDeFirma).codigo).toBe(codigo);
};

describe('una APK real (fabricada con aapt2)', () => {
    it('lee el paquete, el nombre de versión y el código de versión', async () => {
        expect(await leerManifiestoDeApk(path.join(FIXTURES, 'reparto-sin-firmar.apk'))).toEqual({
            paquete: 'cloud.procovar.reparto',
            versionName: '1.2.3',
            versionCode: '45',
        });
    });

    it('lee el de otra aplicación con el suyo (no devuelve siempre lo mismo)', async () => {
        const m = await leerManifiestoDeApk(path.join(FIXTURES, 'ajena-sin-firmar.apk'));
        expect(m.paquete).toBe('com.ejemplo.ajena');
        expect(m.versionCode).toBe('1');
    });
});

describe('lo que NO es una APK', () => {
    it('basura, vacío y demasiado corto', async () => {
        await rechaza(leerManifiestoDeApk(await apk('a.apk', Buffer.from('esto no es un zip, ni de lejos'.repeat(5)))));
        await rechaza(leerManifiestoDeApk(await apk('b.apk', Buffer.alloc(0))));
        await rechaza(leerManifiestoDeApk(await apk('c.apk', Buffer.from('PK'))));
    });

    it('un ZIP cualquiera sin AndroidManifest.xml', async () => {
        await rechaza(leerManifiestoDeApk(await apk('d.apk', zip([{ nombre: 'hola.txt', datos: Buffer.from('hola') }]))));
    });

    it('un AndroidManifest.xml que es texto plano y no AXML', async () => {
        const texto = Buffer.from('<manifest package="cloud.procovar.reparto"/>');
        await rechaza(leerManifiestoDeApk(await apk('e.apk', zip([{ nombre: 'AndroidManifest.xml', datos: texto }]))));
    });

    it('una APK cortada por la mitad', async () => {
        const entera = await import('node:fs').then((fs) => fs.readFileSync(path.join(FIXTURES, 'reparto-sin-firmar.apk')));
        await rechaza(leerManifiestoDeApk(await apk('f.apk', entera.subarray(0, Math.floor(entera.length / 2)))));
    });

    it('un manifiesto que declara más tamaño del que tiene (o que descomprime a más)', async () => {
        const axml = await leerManifiestoCrudo(path.join(FIXTURES, 'reparto-sin-firmar.apk'));
        await rechaza(leerManifiestoDeApk(await apk('g.apk', zip([{ nombre: 'AndroidManifest.xml', datos: axml, metodo: 8, tamReal: axml.length + 7 }]))));
    });

    it('una bomba de compresión en el manifiesto se corta antes de descomprimirla', async () => {
        const bomba = Buffer.alloc(30 * 1024 * 1024, 0); // 30 MB de ceros: comprimen a unos KB
        await rechaza(leerManifiestoDeApk(await apk('h.apk', zip([{ nombre: 'AndroidManifest.xml', datos: bomba, metodo: 8 }]))));
    });

    it('el truco del comentario: un EOCD falso en el comentario del ZIP no despista', async () => {
        const entera = await import('node:fs').then((fs) => fs.readFileSync(path.join(FIXTURES, 'reparto-sin-firmar.apk')));
        // Con el comentario al final, el EOCD verdadero ya no está en los últimos 22 bytes: se busca hacia atrás.
        const axml = await leerManifiestoCrudo(path.join(FIXTURES, 'reparto-sin-firmar.apk'));
        const conComentario = zip([{ nombre: 'AndroidManifest.xml', datos: axml, metodo: 8 }], 'PK\x05\x06 comentario largo con la firma dentro');
        expect((await leerManifiestoDeApk(await apk('i.apk', conComentario))).paquete).toBe('cloud.procovar.reparto');
        expect(entera.length).toBeGreaterThan(0);
    });
});

describe('un AXML manipulado', () => {
    const axml = () => leerManifiestoCrudo(path.join(FIXTURES, 'reparto-sin-firmar.apk'));

    it('no lanza nada que no sea ErrorDeFirma, se toque el byte que se toque', async () => {
        const base = await axml();
        for (let i = 0; i < base.length; i++) {
            const roto = Buffer.from(base);
            roto[i] ^= 0xff;
            try {
                interpretarManifiesto(roto);
            } catch (e) {
                expect(e).toBeInstanceOf(ErrorDeFirma);
            }
        }
    });

    it('truncado en cualquier punto tampoco', async () => {
        const base = await axml();
        for (let n = 0; n < base.length; n += 3) {
            try {
                interpretarManifiesto(base.subarray(0, n));
            } catch (e) {
                expect(e).toBeInstanceOf(ErrorDeFirma);
            }
        }
    });
});
