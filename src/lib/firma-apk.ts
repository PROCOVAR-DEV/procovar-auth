/**
 * FIRMAR UNA APK CON LA CLAVE DE LA CASA (docs/firma-de-apk.md).
 *
 * Recorrido de una firma, y dónde se corta:
 *   1. la subida se guarda en un fichero con nombre inventado por el servidor, contando bytes: pasado el tope se corta SIN
 *      haber leído el resto (`guardarSubida`);
 *   2. se lee el `package` del manifiesto (sin ejecutar nada de la APK) y tiene que ser el de la aplicación elegida;
 *   3. `zipalign` solo si hace falta (una APK ya alineada no se toca);
 *   4. `apksigner sign` con v2+v3; el keystore se descifra a un directorio 0700, las contraseñas viajan por variables de
 *      entorno del proceso hijo (`--ks-pass env:`), NUNCA en la línea de órdenes, y el fichero se borra en cuanto acaba;
 *   5. `apksigner verify --print-certs` sobre el RESULTADO: si no verifica, o si el SHA-256 del certificado no es el de la
 *      casa, no se entrega nada.
 *
 * Todo se ejecuta con `execFile` (sin shell), con tiempo máximo y con un entorno mínimo: el hijo NO hereda `DATABASE_URL`
 * ni `SERVICE_AUTH_SECRET`.
 *
 * TODO (Jose lo decide cuando haya un bucket claro): publicar la APK firmada en MinIO (`/root/secretos/minio.txt`). El gancho
 * es `FirmadoOk` en `firmarArchivo`: el fichero firmado ya está verificado y su sha256 calculado. No se implementa aquí.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { AlmacenDeClaves } from './firma-apk-clave';
import { HUELLA_DE_LA_CASA } from './firma-apk-clave';
import { ErrorDeFirma } from './firma-apk-error';
import { leerManifiestoDeApk, type ManifiestoDeApk } from './firma-apk-manifest';
import { paqueteAdmitido } from './firma-apk-apps';

/** El tope de la subida. */
export const TOPE_DE_APK = 120 * 1024 * 1024;

const TIEMPO_FIRMA_MS = 180_000;
const TIEMPO_HERRAMIENTA_MS = 60_000;

/** Las herramientas: `apksigner` y `zipalign` en el PATH (la imagen las pone ahí). Solo para pruebas locales se pueden apuntar con estas dos. */
const apksigner = () => process.env.APKSIGNER || 'apksigner';
const zipalign = () => process.env.ZIPALIGN || 'zipalign';

// ─── una firma a la vez ──────────────────────────────────────────────────────────────────────────────────────────────────

let enCurso = false;

/** Firmar cuesta CPU y memoria de Java y toca la clave: una sola a la vez. La segunda no espera en cola, se rechaza (429). */
export async function unaFirmaALaVez<T>(trabajo: () => Promise<T>): Promise<T> {
    if (enCurso) throw new ErrorDeFirma('firma_ocupada');
    enCurso = true;
    try {
        return await trabajo();
    } finally {
        enCurso = false;
    }
}

/** Un directorio de trabajo 0700 (lo crea `mkdtemp` así) que desaparece pase lo que pase. */
export async function conDirectorioTemporal<T>(trabajo: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'procovar-firma-'));
    try {
        return await trabajo(dir);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch((e) => logger.warn('[firma-apk] no se pudo borrar el directorio temporal', { error: (e as Error).message }));
    }
}

// ─── la subida ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Guarda el cuerpo de la petición en `destino` leyendo a trozos, y se corta en cuanto pasa de `tope`. Nunca hay más de un
 * trozo en memoria. Devuelve el tamaño y el SHA-256 de lo que llegó.
 */
export async function guardarSubida(cuerpo: ReadableStream<Uint8Array>, destino: string, tope = TOPE_DE_APK): Promise<{ tamano: number; sha256: string }> {
    const fh = await open(destino, 'wx', 0o600);
    const hash = createHash('sha256');
    const lector = cuerpo.getReader();
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await lector.read();
            if (done) break;
            total += value.byteLength;
            if (total > tope) {
                await lector.cancel().catch(() => {});
                throw new ErrorDeFirma('demasiado_grande');
            }
            hash.update(value);
            await fh.write(value);
        }
    } finally {
        await fh.close();
    }
    if (total === 0) throw new ErrorDeFirma('sin_cuerpo');
    return { tamano: total, sha256: hash.digest('hex') };
}

export async function sha256DeFichero(ruta: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const trozo of createReadStream(ruta)) hash.update(trozo as Buffer);
    return hash.digest('hex');
}

// ─── procesos hijos ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Salida {
    codigo: number;
    stdout: string;
    stderr: string;
}

/**
 * Lanza una herramienta SIN shell, con tiempo máximo y un entorno mínimo. `secretos` son variables que solo ve ese proceso
 * (las contraseñas). Un fallo de arranque (la herramienta no existe) y un tiempo agotado son errores propios; un código de
 * salida distinto de 0 se devuelve para que quien llama decida.
 */
function ejecutar(orden: string, args: string[], opciones: { tiempoMs: number; secretos?: Record<string, string>; casa: string }): Promise<Salida> {
    return new Promise((resolver, rechazar) => {
        const hijo = execFile(
            orden,
            args,
            {
                timeout: opciones.tiempoMs,
                killSignal: 'SIGKILL',
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                env: {
                    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                    ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
                    HOME: opciones.casa,
                    LC_ALL: 'C',
                    ...opciones.secretos,
                } as unknown as NodeJS.ProcessEnv, // el tipo de Next exige NODE_ENV; al hijo NO se le pasa
            },
            (error, stdout, stderr) => {
                if (error) {
                    const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
                    if (e.code === 'ENOENT') return rechazar(new ErrorDeFirma('herramienta_no_disponible'));
                    if (e.killed) return rechazar(new ErrorDeFirma('tiempo_agotado'));
                    if (typeof e.code === 'number') return resolver({ codigo: e.code, stdout, stderr });
                    logger.error('[firma-apk] la herramienta no arrancó', { orden: path.basename(orden), codigo: String(e.code ?? '') });
                    return rechazar(new ErrorDeFirma('herramienta_no_disponible'));
                }
                resolver({ codigo: 0, stdout, stderr });
            },
        );
        hijo.stdin?.end();
    });
}

// ─── la verificación ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VerificacionDeFirma {
    huellas: string[];
    v2: boolean;
    v3: boolean;
}

/** Interpreta la salida de `apksigner verify --verbose --print-certs`. Separado para poder probarlo con textos reales. */
export function interpretarVerificacion(stdout: string): VerificacionDeFirma {
    const huellas = [...stdout.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$/gm)].map((m) => m[1].toLowerCase());
    return {
        huellas,
        v2: /^Verified using v2 scheme[^:\n]*:\s*true\s*$/m.test(stdout),
        v3: /^Verified using v3 scheme[^:\n]*:\s*true\s*$/m.test(stdout),
    };
}

// ─── firmar ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FirmadoOk {
    manifiesto: ManifiestoDeApk;
    sha256Entrada: string;
    sha256Salida: string;
    tamano: number;
    /** Dónde quedó la APK firmada (dentro de `dir`; desaparece con él). */
    rutaFirmada: string;
}

/**
 * Firma `entrada` (un fichero que ya está en `dir`) con la clave de `almacen` y deja el resultado en `dir`. Todo lo que se
 * escribe va a `dir` con nombres que pone el servidor. `huellaEsperada` solo cambia en las pruebas (un keystore de juguete).
 */
export async function firmarArchivo(op: {
    dir: string;
    entrada: string;
    clientId: string;
    alias: string;
    almacen: AlmacenDeClaves;
    sha256Entrada: string;
    huellaEsperada?: string;
}): Promise<FirmadoOk> {
    const esperada = (op.huellaEsperada ?? HUELLA_DE_LA_CASA).toLowerCase();

    // 2. Lo que dice el manifiesto manda; el nombre del fichero que subió la persona ni se ve.
    const manifiesto = await leerManifiestoDeApk(op.entrada);
    if (!paqueteAdmitido(op.clientId, manifiesto.paquete)) throw new ErrorDeFirma('paquete_no_permitido');

    const ejecuta = (orden: string, args: string[], tiempoMs: number, secretos?: Record<string, string>) => ejecutar(orden, args, { tiempoMs, secretos, casa: op.dir });

    // 3. Alineada o no: `zipalign -c` sale con 0 si ya lo está. Android 11+ exige resources.arsc sin comprimir y alineado.
    let aFirmar = op.entrada;
    const comprobada = await ejecuta(zipalign(), ['-c', '4', op.entrada], TIEMPO_HERRAMIENTA_MS);
    if (comprobada.codigo !== 0) {
        const alineada = path.join(op.dir, `alineada-${randomUUID()}.apk`);
        const r = await ejecuta(zipalign(), ['-f', '-p', '4', op.entrada, alineada], TIEMPO_HERRAMIENTA_MS);
        if (r.codigo !== 0) {
            logger.error('[firma-apk] zipalign falló', { codigo: r.codigo, stderr: r.stderr.slice(0, 500) });
            throw new ErrorDeFirma('apk_invalida');
        }
        aFirmar = alineada;
    }

    // 4. Firmar. El keystore existe en disco solo mientras dura `apksigner sign`.
    const firmada = path.join(op.dir, `firmada-${randomUUID()}.apk`);
    const ks = path.join(op.dir, `ks-${randomUUID()}`);
    try {
        await writeFile(ks, Buffer.from(op.almacen.keystoreB64, 'base64'), { mode: 0o600, flag: 'wx' });
        const r = await ejecuta(
            apksigner(),
            [
                'sign',
                '--ks', ks,
                '--ks-key-alias', op.alias,
                '--ks-pass', 'env:FIRMA_CLAVE_ALMACEN',
                '--key-pass', 'env:FIRMA_CLAVE_ALIAS',
                '--v2-signing-enabled', 'true',
                '--v3-signing-enabled', 'true',
                '--out', firmada,
                aFirmar,
            ],
            TIEMPO_FIRMA_MS,
            { FIRMA_CLAVE_ALMACEN: op.almacen.claveAlmacen, FIRMA_CLAVE_ALIAS: op.almacen.claveAlias },
        );
        if (r.codigo !== 0) {
            // apksigner no escribe contraseñas en sus mensajes; igualmente, al log y recortado, nunca a la respuesta.
            logger.error('[firma-apk] apksigner sign falló', { codigo: r.codigo, stderr: r.stderr.slice(0, 500) });
            throw new ErrorDeFirma('firma_fallida');
        }
    } finally {
        await rm(ks, { force: true });
    }

    // 5. Verificar EL RESULTADO, no lo que creemos haber hecho.
    const v = await ejecuta(apksigner(), ['verify', '--verbose', '--print-certs', firmada], TIEMPO_HERRAMIENTA_MS);
    if (v.codigo !== 0) {
        logger.error('[firma-apk] apksigner verify falló', { codigo: v.codigo, stderr: v.stderr.slice(0, 500) });
        throw new ErrorDeFirma('verificacion_fallida');
    }
    const leida = interpretarVerificacion(v.stdout);
    if (!leida.v2 || !leida.v3 || leida.huellas.length !== 1) throw new ErrorDeFirma('verificacion_fallida');
    if (leida.huellas[0] !== esperada) throw new ErrorDeFirma('huella_distinta');

    // (aquí: el gancho para publicarla en MinIO, ver el TODO de arriba)
    const sha256Salida = await sha256DeFichero(firmada);
    const { size } = await stat(firmada);
    return { manifiesto, sha256Entrada: op.sha256Entrada, sha256Salida, tamano: size, rutaFirmada: firmada };
}
