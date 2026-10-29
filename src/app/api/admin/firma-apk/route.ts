/**
 * POST /api/admin/firma-apk — firmar una APK con la clave de la casa (docs/firma-de-apk.md).
 *
 *   Cabeceras: Content-Type: application/octet-stream · X-Firma-App: <clientId: delivery-apk | transferencias-apk | crm-apk>
 *   Cuerpo:    la APK tal cual (sin multipart: así el tope se aplica leyendo el flujo, no después de tenerla entera en memoria).
 *   Respuesta: la APK firmada y verificada (`application/vnd.android.package-archive`), con su SHA-256 en `X-Sha256`.
 *              Si algo falla: JSON `{ error: <código>, mensaje }` — nunca texto de Java ni rutas del servidor.
 *
 * Solo el administrador global y solo desde esta misma aplicación (`mismo-origen`). La clave NUNCA sale: ni en la respuesta, ni en
 * los errores, ni en la auditoría. El nombre del fichero que sube la persona no se lee (no viaja): el del que se entrega lo
 * arma el servidor con valores ya validados del manifiesto.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { audit } from '@/lib/audit';
import { requireSystemAdmin } from '@/lib/require-admin';
import { pedidoDeOtroSitio } from '@/lib/mismo-origen';
import { desdeDondePide } from '@/lib/apk-tokens';
import { appDeFirma } from '@/lib/firma-apk-apps';
import { cargarAlmacen } from '@/lib/firma-apk-clave';
import { ErrorDeFirma } from '@/lib/firma-apk-error';
import { conDirectorioTemporal, firmarArchivo, guardarSubida, TOPE_DE_APK, unaFirmaALaVez } from '@/lib/firma-apk';

export const dynamic = 'force-dynamic';
/** Firmar tarda: Java arranca, firma y verifica una APK de decenas de MB. */
export const maxDuration = 300;

const SIN_CACHE = { 'Cache-Control': 'no-store' };
const json = (cuerpo: object, estado = 200) => NextResponse.json(cuerpo, { status: estado, headers: SIN_CACHE });

/** Un trozo de nombre que sea seguro en una cabecera y en un fichero: lo ya validado del manifiesto, y aun así, filtrado. */
const trozo = (s: string | null) => (s ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);

export async function POST(req: NextRequest) {
    const ajeno = pedidoDeOtroSitio(req, ['application/octet-stream']);
    if (ajeno) return ajeno;

    const admin = await requireSystemAdmin();
    if (admin instanceof NextResponse) return admin;

    const clientId = req.headers.get('x-firma-app') ?? '';
    const app = appDeFirma(clientId);
    const aparato = desdeDondePide(req.headers);
    const rechazar = (e: ErrorDeFirma) => {
        audit({
            action: 'apk.firmar_rechazada',
            userId: admin.user.id,
            clientId: app ? clientId : undefined,
            ip: aparato.ip,
            userAgent: aparato.userAgent,
            meta: { motivo: e.codigo },
        });
        return json({ error: e.codigo, mensaje: e.message }, e.estado);
    };

    try {
        if (!app) throw new ErrorDeFirma('app_desconocida');
        if (!req.body) throw new ErrorDeFirma('sin_cuerpo');
        // El aviso temprano: un cuerpo que ya dice ser enorme ni se empieza a leer. El tope DE VERDAD está en `guardarSubida`.
        const declarado = Number(req.headers.get('content-length') ?? '0');
        if (declarado > TOPE_DE_APK) throw new ErrorDeFirma('demasiado_grande');

        const resultado = await unaFirmaALaVez(() =>
            conDirectorioTemporal(async (dir) => {
                const entrada = path.join(dir, `entrada-${randomUUID()}.apk`);
                const { sha256 } = await guardarSubida(req.body as ReadableStream<Uint8Array>, entrada);
                const clave = await cargarAlmacen();
                const firmado = await firmarArchivo({ dir, entrada, clientId, alias: clave.alias, almacen: clave.almacen, sha256Entrada: sha256 });
                // El historial primero: si no se puede dejar constancia, no se entrega.
                await prisma.firmaApk.create({
                    data: {
                        clientId,
                        paquete: firmado.manifiesto.paquete,
                        versionName: firmado.manifiesto.versionName,
                        versionCode: firmado.manifiesto.versionCode,
                        sha256Entrada: firmado.sha256Entrada,
                        sha256Salida: firmado.sha256Salida,
                        tamano: firmado.tamano,
                        userId: admin.user.id,
                    },
                });
                return { firmado, bytes: await readFile(firmado.rutaFirmada) };
            }),
        );

        const { firmado, bytes } = resultado;
        audit({
            action: 'apk.firmar',
            userId: admin.user.id,
            clientId,
            resource: firmado.manifiesto.paquete,
            ip: aparato.ip,
            userAgent: aparato.userAgent,
            meta: {
                app: app.nombre,
                versionName: firmado.manifiesto.versionName,
                versionCode: firmado.manifiesto.versionCode,
                sha256Entrada: firmado.sha256Entrada,
                sha256Salida: firmado.sha256Salida,
                tamano: firmado.tamano,
            },
        });

        const nombre = `${trozo(app.nombre.toLowerCase())}-${trozo(firmado.manifiesto.versionName) || 'sin-version'}-firmada.apk`;
        return new NextResponse(new Uint8Array(bytes), {
            status: 200,
            headers: {
                ...SIN_CACHE,
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Disposition': `attachment; filename="${nombre}"`,
                'Content-Length': String(bytes.length),
                'X-Content-Type-Options': 'nosniff',
                'X-Sha256': firmado.sha256Salida,
                'X-Firma-Paquete': firmado.manifiesto.paquete,
                'X-Firma-Version': trozo(firmado.manifiesto.versionName),
                'Access-Control-Expose-Headers': 'X-Sha256, X-Firma-Paquete, X-Firma-Version, Content-Disposition',
            },
        });
    } catch (e) {
        if (e instanceof ErrorDeFirma) return rechazar(e);
        logger.error('[admin/firma-apk] error', { error: (e as Error).message });
        return json({ error: 'internal_error' }, 500);
    }
}
