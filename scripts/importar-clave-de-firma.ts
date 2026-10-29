import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { prisma } from '../src/lib/prisma'
import { cifrarAlmacen, HUELLA_DE_LA_CASA, ID_DE_LA_CLAVE } from '../src/lib/firma-apk-clave'
import { inspeccionarKeystore, leerClaves } from '../src/lib/firma-apk-importar'

/**
 * Importar UNA VEZ la clave de firma de las APK de la casa (docs/firma-de-apk.md).
 *
 *   npx tsx scripts/importar-clave-de-firma.ts --jks <fichero.jks> --claves <fichero de contraseñas> [--sobrescribir] [--solo-comprobar]
 *
 * · NO genera ninguna clave. Lee un .jks que YA existe y lo guarda cifrado en la base (AES-256-GCM, llave derivada de
 *   SERVICE_AUTH_SECRET: hace falta la misma variable que usa la aplicación).
 * · Comprueba con keytool que la huella SHA-256 del certificado es la de la casa (`HUELLA_DE_LA_CASA`) y SE NIEGA si no
 *   coincide: hay más de un .jks en `.secretos`, y solo uno es el que ya está instalado en los teléfonos.
 * · No pisa una clave ya importada sin `--sobrescribir`.
 * · `--solo-comprobar` hace todo menos tocar la base (ni siquiera la abre): sirve para saber qué .jks es el bueno.
 * · NUNCA imprime una contraseña, ni su longitud: la salida es «importada, huella …» y nada más.
 *
 * Los dos ficheros se indican por argumento y no se copian a ningún sitio. Se ejecuta donde haya un JRE (el contenedor de Accesos).
 */

const USO = 'uso: importar-clave-de-firma.ts --jks <fichero.jks> --claves <fichero de contraseñas> [--sobrescribir] [--solo-comprobar]'

function argumento(nombre: string): string | null {
    const i = process.argv.indexOf(nombre)
    return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const hay = (nombre: string) => process.argv.includes(nombre)

async function main() {
    const jks = argumento('--jks')
    const claves = argumento('--claves')
    if (!jks || !claves || jks.startsWith('--') || claves.startsWith('--')) {
        console.error(USO)
        process.exit(2)
    }
    const soloComprobar = hay('--solo-comprobar')

    const leidas = leerClaves(await readFile(claves, 'utf8'))
    const k = await inspeccionarKeystore({ jks, claves: leidas })

    if (k.huella !== HUELLA_DE_LA_CASA) {
        // La huella es un dato público (la lleva cualquier APK firmada); decirla ayuda a ver qué fichero era.
        console.error(`NO importada: la huella de ese almacén es ${k.huella} y la de la casa es ${HUELLA_DE_LA_CASA}.`)
        process.exit(1)
    }
    if (soloComprobar) {
        console.log(`comprobada, huella ${k.huella} (no se ha tocado la base)`)
        return
    }

    const existente = await prisma.claveDeFirmaApk.findUnique({ where: { id: ID_DE_LA_CLAVE }, select: { huella: true } })
    if (existente && !hay('--sobrescribir')) {
        console.error(`NO importada: ya hay una clave importada (huella ${existente.huella}). Con --sobrescribir se vuelve a cifrar.`)
        process.exit(1)
    }

    const almacen = {
        keystoreB64: (await readFile(jks)).toString('base64'),
        claveAlmacen: leidas.claveAlmacen,
        claveAlias: leidas.claveAlias,
    }
    const datos = {
        huella: k.huella,
        sujeto: k.sujeto,
        validoDesde: k.validoDesde,
        validoHasta: k.validoHasta,
        alias: k.alias,
        formato: 1,
        cifrado: new Uint8Array(cifrarAlmacen(almacen, k.huella)),
    }
    await prisma.claveDeFirmaApk.upsert({ where: { id: ID_DE_LA_CLAVE }, create: { id: ID_DE_LA_CLAVE, ...datos }, update: datos })
    await prisma.auditLog.create({
        data: { action: 'apk.clave_importada', resource: ID_DE_LA_CLAVE, meta: { huella: k.huella, sobrescrita: Boolean(existente) } },
    })
    console.log(`importada, huella ${k.huella}`)
}

main()
    .catch((e) => {
        // Solo el mensaje: ninguno de los errores de arriba lleva contraseñas, pero un volcado de pila de Prisma podría llevar la conexión.
        console.error(`ERROR: ${(e as Error).message}`)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect().catch(() => {})
    })
