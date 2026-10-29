/**
 * LO QUE NECESITA EL SCRIPT `scripts/importar-clave-de-firma.ts` para importar la clave una vez (docs/firma-de-apk.md).
 *
 * Aquí está la parte que se puede probar sin base: leer el fichero de contraseñas, abrir el keystore con `keytool` y sacar de
 * él la huella SHA-256 del certificado. Las contraseñas pasan a `keytool` por variables de entorno (`-storepass:env`), nunca
 * por la línea de órdenes, y ningún mensaje de error las incluye ni dice su longitud.
 *
 * NUNCA se genera una clave: esto solo LEE un .jks que ya existe.
 */
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

export interface ClavesLeidas {
    claveAlmacen: string;
    claveAlias: string;
    alias: string | null;
}

export interface KeystoreInspeccionado {
    alias: string;
    huella: string;
    sujeto: string;
    validoDesde: Date;
    validoHasta: Date;
}

/**
 * El fichero de contraseñas. Se aceptan los dos formatos que hay en `.secretos` y el más simple:
 *   · `CLAVE_ALMACEN=…` / `CLAVE_ALIAS=…` / `ALIAS=…`  (también `storepass`, `keypass`, `storePassword`, `keyPassword`);
 *   · `clave: …` (una sola contraseña para las dos cosas);
 *   · una sola línea con la contraseña.
 * Las líneas que empiezan por `#` y las de otras claves (`ALMACEN=`, `fichero:`, `CERT_SHA256=`…) se ignoran.
 */
export function leerClaves(texto: string): ClavesLeidas {
    const valores = new Map<string, string>();
    const sueltas: string[] = [];
    for (const cruda of texto.split(/\r?\n/)) {
        const linea = cruda.trim();
        if (!linea || linea.startsWith('#')) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(linea);
        if (!m) {
            sueltas.push(linea);
            continue;
        }
        const valor = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
        if (valor) valores.set(m[1].toLowerCase(), valor);
    }
    const primero = (...claves: string[]) => claves.map((c) => valores.get(c)).find((v) => v !== undefined) ?? null;

    const almacen = primero('clave_almacen', 'storepass', 'storepassword', 'store_password', 'clave') ?? (sueltas.length === 1 && valores.size === 0 ? sueltas[0] : null);
    if (!almacen) throw new Error('El fichero de contraseñas no tiene la contraseña del almacén (CLAVE_ALMACEN=…, clave: … o una sola línea).');
    return {
        claveAlmacen: almacen,
        claveAlias: primero('clave_alias', 'keypass', 'keypassword', 'key_password') ?? almacen,
        alias: primero('alias', 'keyalias', 'key_alias'),
    };
}

function keytool(args: string[], secretos: Record<string, string>): Promise<{ codigo: number; stdout: string }> {
    return new Promise((resolver, rechazar) => {
        const hijo = execFile(
            process.env.KEYTOOL || 'keytool',
            ['-J-Duser.language=en', '-J-Duser.country=US', ...args],
            {
                timeout: 30_000,
                killSignal: 'SIGKILL',
                maxBuffer: 1024 * 1024,
                env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}), LC_ALL: 'C', ...secretos } as unknown as NodeJS.ProcessEnv,
            },
            (error, stdout) => {
                const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
                if (e && typeof e.code !== 'number') return rechazar(new Error('No se pudo ejecutar keytool (¿hay un JRE instalado?).'));
                resolver({ codigo: typeof e?.code === 'number' ? e.code : 0, stdout });
            },
        );
        hijo.stdin?.end();
    });
}

const minusculasSinDosPuntos = (h: string) => h.replace(/:/g, '').toLowerCase();

/**
 * Abre el keystore con `keytool` y devuelve el alias, la huella SHA-256 y los datos públicos del certificado. Comprueba además
 * que la contraseña de la CLAVE (no solo la del almacén) abre la clave privada, para no importar algo que luego no firma.
 */
export async function inspeccionarKeystore(op: { jks: string; claves: ClavesLeidas }): Promise<KeystoreInspeccionado> {
    const base = ['-keystore', op.jks, '-storepass:env', 'FIRMA_IMPORT_ALMACEN'];
    const secretos = { FIRMA_IMPORT_ALMACEN: op.claves.claveAlmacen, FIRMA_IMPORT_ALIAS: op.claves.claveAlias };

    const lista = await keytool(['-list', '-v', ...base], secretos);
    if (lista.codigo !== 0) throw new Error('keytool no pudo abrir el almacén (fichero o contraseña del almacén incorrectos).');

    // Un bloque por alias; solo cuentan las claves privadas (un .jks puede llevar certificados de confianza sueltos).
    const bloques = lista.stdout.split(/^Alias name:\s*/m).slice(1).filter((b) => /^Entry type:\s*PrivateKeyEntry/m.test(b));
    const candidatos = bloques.map((b) => ({ alias: b.split(/\r?\n/, 1)[0].trim(), huella: /^\s*SHA256:\s*([0-9A-Fa-f:]{95})\s*$/m.exec(b)?.[1] ?? '' }));
    const elegido = op.claves.alias ? candidatos.find((c) => c.alias.toLowerCase() === op.claves.alias!.toLowerCase()) : candidatos.length === 1 ? candidatos[0] : undefined;
    if (!elegido) {
        throw new Error(candidatos.length > 1 ? 'El almacén tiene varias claves: indica cuál con ALIAS=… en el fichero de contraseñas.' : 'No se encontró la clave (alias) en el almacén.');
    }

    const exportado = await keytool(['-exportcert', '-rfc', '-alias', elegido.alias, ...base], secretos);
    if (exportado.codigo !== 0) throw new Error('keytool no pudo exportar el certificado.');
    const cert = new X509Certificate(exportado.stdout);
    const huella = minusculasSinDosPuntos(cert.fingerprint256);
    // Dos lecturas independientes de la misma huella: la de `keytool -list` y la de Node sobre el certificado exportado.
    if (minusculasSinDosPuntos(elegido.huella) !== huella) throw new Error('La huella que da keytool no coincide con la del certificado exportado.');

    // La contraseña de la clave: pedir una solicitud de certificado exige descifrar la clave privada.
    const prueba = await keytool(['-certreq', '-alias', elegido.alias, '-keypass:env', 'FIRMA_IMPORT_ALIAS', ...base], secretos);
    if (prueba.codigo !== 0) throw new Error('La contraseña de la clave (CLAVE_ALIAS) no abre la clave privada.');

    return {
        alias: elegido.alias,
        huella,
        sujeto: cert.subject.split('\n').reverse().join(', '),
        validoDesde: new Date(cert.validFrom),
        validoHasta: new Date(cert.validTo),
    };
}
