import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { datosPublicos, HUELLA_DE_LA_CASA } from "@/lib/firma-apk-clave";
import { APPS_DE_FIRMA } from "@/lib/firma-apk-apps";
import { TOPE_DE_APK } from "@/lib/firma-apk";
import { FirmaApkPanel, type FilaDeFirma } from "@/components/admin/firma-apk-panel.component";

export const dynamic = "force-dynamic";

/** Cuántas firmas se enseñan. Las demás siguen en la tabla y en la auditoría. */
const TOPE_HISTORIAL = 50;

/**
 * «Firma de las APK» (docs/firma-de-apk.md): el certificado de la casa, qué aplicaciones firma y el historial; y el botón para
 * firmar una APK. Solo el administrador global, como todo el panel. La clave y sus contraseñas NO llegan nunca aquí:
 * `datosPublicos()` lee solo huella, sujeto y validez.
 */
export default async function FirmaDeApkPage() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) redirect("/");
    if (!session.user.isSystemAdmin) redirect("/profile");

    const [clave, firmas] = await Promise.all([
        datosPublicos(),
        prisma.firmaApk.findMany({ orderBy: { createdAt: "desc" }, take: TOPE_HISTORIAL }),
    ]);
    const personas = await prisma.user.findMany({
        where: { id: { in: [...new Set(firmas.map((f) => f.userId))] } },
        select: { id: true, name: true },
    });
    const nombres = new Map(personas.map((p) => [p.id, p.name]));

    const filas: FilaDeFirma[] = firmas.map((f) => ({
        id: f.id,
        cuando: f.createdAt.toISOString(),
        quien: nombres.get(f.userId) ?? "Persona eliminada",
        app: APPS_DE_FIRMA[f.clientId]?.nombre ?? f.clientId,
        paquete: f.paquete,
        version: [f.versionName, f.versionCode ? `(${f.versionCode})` : null].filter(Boolean).join(" ") || null,
        sha256: f.sha256Salida,
        tamano: f.tamano,
    }));

    return (
        <FirmaApkPanel
            certificado={
                clave && {
                    sujeto: clave.sujeto,
                    huella: clave.huella,
                    validoDesde: clave.validoDesde.toISOString(),
                    validoHasta: clave.validoHasta.toISOString(),
                    importadaEl: clave.importadaEl.toISOString(),
                    esLaEsperada: clave.huella === HUELLA_DE_LA_CASA,
                    caducado: clave.validoHasta < new Date(),
                }
            }
            apps={Object.entries(APPS_DE_FIRMA).map(([clientId, a]) => ({ clientId, nombre: a.nombre, paquetes: [...a.paquetes] }))}
            filas={filas}
            topeMb={Math.round(TOPE_DE_APK / 1024 / 1024)}
        />
    );
}
