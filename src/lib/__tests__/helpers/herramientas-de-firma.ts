/**
 * Ayudas de las pruebas de la firma de APK: encontrar keytool / apksigner / zipalign y fabricar un keystore DE JUGUETE.
 * Nada de aquí toca la clave real de la casa: la huella "esperada" de las pruebas es la del juguete.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function enElPath(nombre: string): string | null {
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
        const p = path.join(d, nombre);
        if (d && existsSync(p)) return p;
    }
    return null;
}

/** apksigner y zipalign: los del PATH (la imagen de Docker), o los del SDK de Android del portátil de desarrollo. */
function delSdk(nombre: string): string | null {
    const raiz = path.join(process.env.ANDROID_HOME ?? path.join(homedir(), 'Android', 'sdk'), 'build-tools');
    if (!existsSync(raiz)) return null;
    for (const v of readdirSync(raiz).sort().reverse()) {
        const p = path.join(raiz, v, nombre);
        if (existsSync(p)) return p;
    }
    return null;
}

export function herramientas() {
    const keytool = process.env.KEYTOOL || enElPath('keytool');
    const apksigner = process.env.APKSIGNER || enElPath('apksigner') || delSdk('apksigner');
    const zipalign = process.env.ZIPALIGN || enElPath('zipalign') || delSdk('zipalign');
    const java = enElPath('java');
    return { keytool, apksigner, zipalign, java, completas: Boolean(keytool && apksigner && zipalign && java) };
}

/** Deja las variables que leen `firma-apk.ts` y `firma-apk-importar.ts` apuntando a las herramientas encontradas. */
export function usarHerramientas() {
    const h = herramientas();
    if (h.keytool) process.env.KEYTOOL = h.keytool;
    if (h.apksigner) process.env.APKSIGNER = h.apksigner;
    if (h.zipalign) process.env.ZIPALIGN = h.zipalign;
    return h;
}

export interface KeystoreDeJuguete {
    ruta: string;
    alias: string;
    claveAlmacen: string;
    claveAlias: string;
    /** SHA-256 del certificado, calculado aparte (keytool -exportcert + Node), no con el código que se prueba. */
    huella: string;
}

/** Un .jks (JKS de verdad, con contraseña de almacén DISTINTA de la de la clave, como el real) con una clave RSA recién creada. */
export function crearKeystoreDeJuguete(dir: string, nombre = 'juguete.jks'): KeystoreDeJuguete {
    const keytool = herramientas().keytool!;
    const ruta = path.join(dir, nombre);
    const claveAlmacen = `a${randomBytes(9).toString('hex')}`;
    const claveAlias = `k${randomBytes(9).toString('hex')}`;
    const env = { PATH: process.env.PATH ?? '', JUGUETE_A: claveAlmacen, JUGUETE_K: claveAlias } as unknown as NodeJS.ProcessEnv;
    execFileSync(
        keytool,
        ['-genkeypair', '-alias', 'juguete', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-storetype', 'JKS', '-keystore', ruta,
            '-storepass:env', 'JUGUETE_A', '-keypass:env', 'JUGUETE_K', '-dname', 'CN=Juguete Procovar, O=Pruebas'],
        { env, stdio: 'pipe' },
    );
    const pem = execFileSync(keytool, ['-exportcert', '-rfc', '-alias', 'juguete', '-keystore', ruta, '-storepass:env', 'JUGUETE_A'], { env, stdio: 'pipe' }).toString();
    const huella = new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
    return { ruta, alias: 'juguete', claveAlmacen, claveAlias, huella };
}
