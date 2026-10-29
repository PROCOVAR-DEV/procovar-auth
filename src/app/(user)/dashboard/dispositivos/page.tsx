import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { DispositivosTabla } from "@/components/admin/dispositivos-tabla.component";
import { aFila, pestanas } from "@/lib/dispositivos-vista";

export const dynamic = "force-dynamic";

/** Cuántos aparatos se traen por aplicación. Sobra: hay decenas. Si algún día se pasa, se AVISA (`truncada`). */
const TOPE = 500;

/**
 * Los dispositivos de todas las aplicaciones, una pestaña por aplicación (`docs/dispositivos.md`).
 *
 * Accesos guarda quién y qué es cada aparato (persona, aplicación, versión ACTUAL, plataforma, última vez visto) y lo que el
 * aparato cuenta de sí mismo; lo que HIZO (su cola, sus rechazos) lo guarda cada aplicación, y desde aquí se llega con
 * «Ver actividad». Solo el administrador global, como todo el panel.
 */
export default async function DispositivosPage({ searchParams }: { searchParams: Promise<{ app?: string; sucursal?: string }> }) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) redirect("/");
    if (!session.user.isSystemAdmin) redirect("/profile");

    const filtros = await searchParams;

    const conAparatos = await prisma.dispositivo.groupBy({ by: ["clientId"], _count: { _all: true } });
    const tabs = pestanas(conAparatos.map((c) => c.clientId));
    const app = tabs.some((t) => t.clientId === filtros.app) ? (filtros.app as string) : tabs[0].clientId;
    const sucursal = filtros.sucursal?.trim().toUpperCase() || "";

    const [filas, sucursales, plantilla] = await Promise.all([
        prisma.dispositivo.findMany({
            where: { clientId: app, ...(sucursal ? { sucursal } : {}) },
            orderBy: { vistoAt: "desc" },
            take: TOPE + 1,
        }),
        prisma.dispositivo.findMany({ where: { clientId: app, sucursal: { not: null } }, distinct: ["sucursal"], select: { sucursal: true }, orderBy: { sucursal: "asc" } }),
        // «Ver actividad»: la dirección que la aplicación apuntó en su ficha. `crm-apk` → la ficha `crm`.
        prisma.clientApp.findFirst({
            where: { clientId: { in: [app, app.replace(/-apk$/, "")] }, dispositivosUrl: { not: null } },
            select: { dispositivosUrl: true },
        }),
    ]);

    const truncada = filas.length > TOPE;
    const mostradas = truncada ? filas.slice(0, TOPE) : filas;
    const personas = await prisma.user.findMany({
        where: { id: { in: [...new Set(mostradas.map((d) => d.userId))] } },
        select: { id: true, name: true },
    });
    const nombres = new Map(personas.map((p) => [p.id, p.name]));
    const ahora = new Date();

    return (
        <DispositivosTabla
            pestanas={tabs}
            app={app}
            sucursal={sucursal}
            sucursales={sucursales.flatMap((s) => (s.sucursal ? [s.sucursal] : []))}
            filas={mostradas.map((d) => aFila(d, nombres, plantilla?.dispositivosUrl ?? null, ahora))}
            truncada={truncada}
            tope={TOPE}
        />
    );
}
