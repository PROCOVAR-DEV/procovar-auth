/**
 * LEER EL `package` Y LA VERSIÓN DE UNA APK SIN EJECUTAR NADA DE ELLA (docs/firma-de-apk.md).
 *
 * Una APK es un ZIP y su `AndroidManifest.xml` va en XML binario de Android (AXML). Aquí se lee el ZIP por su directorio
 * central (sin descomprimir todo, sin tocar el disco más que para leer) y se interpreta el AXML a mano: no hace falta `aapt2`
 * (que en la imagen de Alpine no corre: es de glibc) y no se lanza ningún proceso con un fichero que viene de fuera.
 *
 * Defensas, porque el fichero lo sube una persona pero NO es de fiar:
 *   · solo se descomprime UNA entrada (el manifiesto) y con tope (`MAX_MANIFIESTO`): una bomba de compresión no pasa;
 *   · todo desplazamiento y longitud se comprueba contra el tamaño real antes de leer;
 *   · ZIP64 se rechaza (una APK de ≤120 MB no lo necesita, y es un territorio de rarezas).
 *
 * Límite conocido: `versionName` puede ser una referencia a un recurso (`@string/…`), que viven en `resources.arsc` y aquí no
 * se resuelven; en ese caso sale `null` y la pantalla lo dice. El `package` NUNCA puede ser una referencia: si no es un texto
 * directo, se rechaza.
 */
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ErrorDeFirma } from './firma-apk-error';

const MAX_MANIFIESTO = 5 * 1024 * 1024;
const MAX_DIRECTORIO_CENTRAL = 16 * 1024 * 1024;
const NO_HAY = 0xffffffff;

export interface ManifiestoDeApk {
    paquete: string;
    versionName: string | null;
    versionCode: string | null;
}

/** Un `applicationId` de Android: segmentos separados por puntos, cada uno empieza por letra. Al menos dos. */
const PAQUETE_VALIDO = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

// ─── ZIP ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** El contenido (ya descomprimido) de `AndroidManifest.xml`, o `apk_invalida`. */
export async function leerManifiestoCrudo(ruta: string): Promise<Buffer> {
    const fh = await open(ruta, 'r');
    try {
        const { size } = await fh.stat();
        const leer = async (desde: number, largo: number): Promise<Buffer> => {
            if (desde < 0 || largo < 0 || desde + largo > size) throw new ErrorDeFirma('apk_invalida');
            const b = Buffer.alloc(largo);
            const { bytesRead } = await fh.read(b, 0, largo, desde);
            if (bytesRead !== largo) throw new ErrorDeFirma('apk_invalida');
            return b;
        };
        if (size < 22) throw new ErrorDeFirma('apk_invalida');

        // El final del directorio central (EOCD) está en los últimos 22 bytes + el comentario (≤ 65535).
        const cola = await leer(Math.max(0, size - 65_557), Math.min(size, 65_557));
        let e = -1;
        for (let i = cola.length - 22; i >= 0; i--) {
            // El verdadero es el que cuenta un comentario que llega justo hasta el final: un «PK\5\6» dentro del comentario no vale.
            if (cola.readUInt32LE(i) === 0x06054b50 && i + 22 + cola.readUInt16LE(i + 20) === cola.length) {
                e = i;
                break;
            }
        }
        if (e < 0) throw new ErrorDeFirma('apk_invalida');
        const total = cola.readUInt16LE(e + 10);
        const tamDirectorio = cola.readUInt32LE(e + 12);
        const desdeDirectorio = cola.readUInt32LE(e + 16);
        if (total === 0xffff || tamDirectorio === NO_HAY || desdeDirectorio === NO_HAY) throw new ErrorDeFirma('apk_invalida'); // ZIP64
        if (tamDirectorio > MAX_DIRECTORIO_CENTRAL) throw new ErrorDeFirma('apk_invalida');

        const dir = await leer(desdeDirectorio, tamDirectorio);
        let p = 0;
        for (let n = 0; n < total; n++) {
            if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new ErrorDeFirma('apk_invalida');
            const metodo = dir.readUInt16LE(p + 10);
            const tamComprimido = dir.readUInt32LE(p + 20);
            const tamReal = dir.readUInt32LE(p + 24);
            const largoNombre = dir.readUInt16LE(p + 28);
            const largoExtra = dir.readUInt16LE(p + 30);
            const largoComentario = dir.readUInt16LE(p + 32);
            const desdeLocal = dir.readUInt32LE(p + 42);
            if (p + 46 + largoNombre > dir.length) throw new ErrorDeFirma('apk_invalida');
            const nombre = dir.toString('utf8', p + 46, p + 46 + largoNombre);
            p += 46 + largoNombre + largoExtra + largoComentario;
            if (nombre !== 'AndroidManifest.xml') continue;

            if (tamComprimido > MAX_MANIFIESTO || tamReal > MAX_MANIFIESTO || tamReal === 0) throw new ErrorDeFirma('apk_invalida');
            const local = await leer(desdeLocal, 30);
            if (local.readUInt32LE(0) !== 0x04034b50) throw new ErrorDeFirma('apk_invalida');
            const inicio = desdeLocal + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
            const datos = await leer(inicio, tamComprimido);
            let crudo: Buffer;
            if (metodo === 0) crudo = datos;
            else if (metodo === 8) {
                try {
                    crudo = inflateRawSync(datos, { maxOutputLength: MAX_MANIFIESTO });
                } catch {
                    throw new ErrorDeFirma('apk_invalida');
                }
            } else throw new ErrorDeFirma('apk_invalida');
            if (crudo.length !== tamReal) throw new ErrorDeFirma('apk_invalida');
            return crudo;
        }
        throw new ErrorDeFirma('apk_invalida'); // un ZIP cualquiera, sin AndroidManifest.xml
    } finally {
        await fh.close();
    }
}

// ─── AXML ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TIPO_XML = 0x0003;
const TIPO_POOL = 0x0001;
const TIPO_ELEMENTO = 0x0102;
const SIN_VALOR = 0xffffffff;
const TIPO_TEXTO = 0x03;
const TIPO_ENTERO = 0x10;
const TIPO_HEX = 0x11;

/** La tabla de textos de un AXML. Devuelve una función que lee el texto `i` (null si no existe). */
function leerPool(b: Buffer, o: number): (i: number) => string | null {
    const cabecera = b.readUInt16LE(o + 2);
    const cuantos = b.readUInt32LE(o + 8);
    const banderas = b.readUInt32LE(o + 16);
    const inicioTextos = b.readUInt32LE(o + 20);
    const tamChunk = b.readUInt32LE(o + 4);
    if (cuantos > 1_000_000 || o + cabecera + cuantos * 4 > o + tamChunk) throw new ErrorDeFirma('apk_invalida');
    const utf8 = (banderas & 0x100) !== 0;
    return (i) => {
        if (i < 0 || i >= cuantos) return null;
        let p = o + inicioTextos + b.readUInt32LE(o + cabecera + i * 4);
        if (p >= o + tamChunk) throw new ErrorDeFirma('apk_invalida');
        if (utf8) {
            // Dos longitudes de 1 o 2 bytes (caracteres, luego bytes); interesa la segunda.
            const largo = () => {
                const c = b[p++];
                return c & 0x80 ? ((c & 0x7f) << 8) | b[p++] : c;
            };
            largo();
            const bytes = largo();
            if (p + bytes > o + tamChunk) throw new ErrorDeFirma('apk_invalida');
            return b.toString('utf8', p, p + bytes);
        }
        let n = b.readUInt16LE(p);
        p += 2;
        if (n & 0x8000) {
            n = ((n & 0x7fff) << 16) | b.readUInt16LE(p);
            p += 2;
        }
        if (p + n * 2 > o + tamChunk) throw new ErrorDeFirma('apk_invalida');
        return b.toString('utf16le', p, p + n * 2);
    };
}

/** Interpreta el AXML de un `AndroidManifest.xml` y devuelve lo que dice el elemento `<manifest>`. */
export function interpretarManifiesto(b: Buffer): ManifiestoDeApk {
    try {
        if (b.length < 8 || b.readUInt16LE(0) !== TIPO_XML) throw new ErrorDeFirma('apk_invalida');
        let pool: ((i: number) => string | null) | null = null;
        let o = 8;
        while (o + 8 <= b.length) {
            const tipo = b.readUInt16LE(o);
            const tam = b.readUInt32LE(o + 4);
            if (tam < 8 || o + tam > b.length) throw new ErrorDeFirma('apk_invalida');
            if (tipo === TIPO_POOL) pool = leerPool(b, o);
            else if (tipo === TIPO_ELEMENTO) {
                if (!pool) throw new ErrorDeFirma('apk_invalida');
                if (pool(b.readUInt32LE(o + 20)) !== 'manifest') throw new ErrorDeFirma('apk_invalida'); // el primer elemento ha de ser <manifest>
                const desde = o + 16 + b.readUInt16LE(o + 24);
                const largoAtributo = b.readUInt16LE(o + 26);
                const cuantos = b.readUInt16LE(o + 28);
                if (largoAtributo < 20 || desde + cuantos * largoAtributo > o + tam) throw new ErrorDeFirma('apk_invalida');
                const valores: Record<string, string> = {};
                for (let i = 0; i < cuantos; i++) {
                    const a = desde + i * largoAtributo;
                    const nombre = pool(b.readUInt32LE(a + 4));
                    if (nombre !== 'package' && nombre !== 'versionName' && nombre !== 'versionCode') continue;
                    const crudo = b.readUInt32LE(a + 8);
                    const clase = b[a + 15];
                    const dato = b.readUInt32LE(a + 16);
                    const v =
                        crudo !== SIN_VALOR
                            ? pool(crudo)
                            : clase === TIPO_TEXTO
                              ? pool(dato)
                              : clase === TIPO_ENTERO
                                ? String(dato)
                                : clase === TIPO_HEX
                                  ? String(dato)
                                  : null; // una referencia a un recurso: aquí no se resuelve
                    if (v != null) valores[nombre] = v;
                }
                const paquete = valores.package;
                if (!paquete || !PAQUETE_VALIDO.test(paquete) || paquete.length > 255) throw new ErrorDeFirma('apk_invalida');
                return {
                    paquete,
                    versionName: valores.versionName ? valores.versionName.slice(0, 64) : null,
                    versionCode: valores.versionCode ?? null,
                };
            }
            o += tam;
        }
        throw new ErrorDeFirma('apk_invalida');
    } catch (e) {
        // Un desplazamiento fuera de rango en un AXML manipulado lanza RangeError: es «APK inválida», no un 500.
        throw e instanceof ErrorDeFirma ? e : new ErrorDeFirma('apk_invalida');
    }
}

/** El `package` y la versión de la APK que está en `ruta`. */
export async function leerManifiestoDeApk(ruta: string): Promise<ManifiestoDeApk> {
    return interpretarManifiesto(await leerManifiestoCrudo(ruta));
}
