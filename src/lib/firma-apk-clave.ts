/**
 * LA CLAVE DE FIRMA DE LA CASA, CIFRADA EN LA BASE (docs/firma-de-apk.md). DECISIÓN DE JOSE (29/10/2026): vive dentro de Accesos.
 *
 * Lo que se guarda (tabla `firma_apk_clave`, una sola fila): el keystore (.jks) y sus dos contraseñas, juntos, en UN bloque
 * cifrado con AES-256-GCM. La clave de cifrado se DERIVA con HKDF de `SERVICE_AUTH_SECRET` —el mismo secreto del que cuelga
 * `deriveSigningKey`—, así que no hay ninguna variable de entorno nueva y no hay una segunda llave que guardar.
 *
 *   · La huella viaja como dato autenticado (AAD): cambiar la columna `huella` sin la clave rompe el descifrado.
 *   · Cada cifrado lleva un IV nuevo de 12 bytes al azar.
 *   · LA CLAVE NUNCA SALE: este módulo es el único que la descifra, y lo único que devuelve hacia la pantalla es `datosPublicos()`
 *     (huella, sujeto, validez: lo mismo que lleva el certificado de cualquier APK ya firmada).
 *
 * TRAMPA: si se cambia `SERVICE_AUTH_SECRET` la clave guardada deja de poder descifrarse (`clave_ilegible`) y la pantalla
 * deja de firmar. No se pierde nada —el .jks sigue en `.secretos`—, pero hay que volver a importarla con `--sobrescribir`
 * DESPUÉS del cambio (docs/firma-de-apk.md, «Si cambia SERVICE_AUTH_SECRET»).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { ErrorDeFirma } from './firma-apk-error';

/**
 * SHA-256 del certificado de la casa (hex, minúsculas). Es un dato PÚBLICO: lo enseña cualquier APK de Reparto
 * (`apksigner verify --print-certs`). Es lo que Android compara para dejar instalar una versión encima de la anterior.
 * No se cambia nunca (ver «NO generar una clave nueva» en docs/firma-de-apk.md).
 */
export const HUELLA_DE_LA_CASA = '01529f5a6fb1a238985745aff13cdcf7e8e85b624992f4e328bde9898fd80b21';

export const ID_DE_LA_CLAVE = 'casa';
const FORMATO = 1;

/** Lo que va cifrado. Nunca se loguea, nunca se devuelve. */
export interface AlmacenDeClaves {
    /** El .jks entero, en base64. */
    keystoreB64: string;
    claveAlmacen: string;
    claveAlias: string;
}

export interface DatosPublicosDeLaClave {
    huella: string;
    sujeto: string;
    validoDesde: Date;
    validoHasta: Date;
    alias: string;
    importadaEl: Date;
}

/** La llave AES-256 de esta función. Falla (sin decir por qué) si no hay `SERVICE_AUTH_SECRET` utilizable. */
function llaveDeCifrado(): Buffer {
    const secreto = process.env.SERVICE_AUTH_SECRET;
    if (!secreto || secreto.length < 32) throw new ErrorDeFirma('clave_ilegible');
    return Buffer.from(hkdfSync('sha256', Buffer.from(secreto, 'utf8'), 'procovar-accesos/firma-apk/v1', 'aes-256-gcm', 32));
}

const aad = (huella: string) => Buffer.from(`procovar-firma-apk:v${FORMATO}:${huella}`, 'utf8');

/** [iv 12][etiqueta 16][texto cifrado] */
export function cifrarAlmacen(almacen: AlmacenDeClaves, huella: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', llaveDeCifrado(), iv);
    c.setAAD(aad(huella));
    const cifrado = Buffer.concat([c.update(JSON.stringify(almacen), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), cifrado]);
}

/** Lo contrario. Cualquier fallo (llave distinta, bloque tocado, huella cambiada) es `clave_ilegible`, sin más detalle. */
export function descifrarAlmacen(bloque: Uint8Array, huella: string): AlmacenDeClaves {
    try {
        const b = Buffer.from(bloque);
        if (b.length < 12 + 16 + 1) throw new Error('corto');
        const d = createDecipheriv('aes-256-gcm', llaveDeCifrado(), b.subarray(0, 12));
        d.setAAD(aad(huella));
        d.setAuthTag(b.subarray(12, 28));
        const claro = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
        const a = JSON.parse(claro) as Partial<AlmacenDeClaves>;
        if (typeof a.keystoreB64 !== 'string' || typeof a.claveAlmacen !== 'string' || typeof a.claveAlias !== 'string') throw new Error('forma');
        return { keystoreB64: a.keystoreB64, claveAlmacen: a.claveAlmacen, claveAlias: a.claveAlias };
    } catch {
        throw new ErrorDeFirma('clave_ilegible');
    }
}

/** Lo público de la clave guardada, o null si todavía no se importó. NUNCA lee la columna `cifrado`. */
export async function datosPublicos(): Promise<DatosPublicosDeLaClave | null> {
    const f = await prisma.claveDeFirmaApk.findUnique({
        where: { id: ID_DE_LA_CLAVE },
        select: { huella: true, sujeto: true, validoDesde: true, validoHasta: true, alias: true, updatedAt: true },
    });
    return f ? { huella: f.huella, sujeto: f.sujeto, validoDesde: f.validoDesde, validoHasta: f.validoHasta, alias: f.alias, importadaEl: f.updatedAt } : null;
}

/** La clave DESCIFRADA, para firmar. Solo `lib/firma-apk.ts` y la ruta de firma la piden. */
export async function cargarAlmacen(): Promise<{ huella: string; alias: string; almacen: AlmacenDeClaves }> {
    const f = await prisma.claveDeFirmaApk.findUnique({ where: { id: ID_DE_LA_CLAVE } });
    if (!f) throw new ErrorDeFirma('sin_clave');
    return { huella: f.huella, alias: f.alias, almacen: descifrarAlmacen(f.cifrado, f.huella) };
}
