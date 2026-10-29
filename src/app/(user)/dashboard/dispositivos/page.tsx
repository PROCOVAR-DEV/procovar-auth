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

    const conAparatos = await prisma.dispositivoApp.groupBy({ by: ["clientId"], _count: { _all: true } });
    const tabs = pestanas(conAparatos.map((c) => c.clientId));
    const app = tabs.some((t) => t.clientId === filtros.app) ? (filtros.app as string) : tabs[0].clientId;
    const sucursal = filtros.sucursal?.trim().toUpperCase() || "";

    const [filas, sucursales, plantilla] = await Promise.all([
        prisma.dispositivoApp.findMany({
            where: { clientId: app, ...(sucursal ? { sucursal } : {}) },
            orderBy: { vistoAt: "desc" },
            take: TOPE + 1,
            include: { dispositivo: true, personas: true },
        }),
        prisma.dispositivoApp.findMany({ where: { clientId: app, sucursal: { not: null } }, distinct: ["sucursal"], select: { sucursal: true }, orderBy: { sucursal: "asc" } }),
        // «Ver actividad»: la dirección que la aplicación apuntó en su ficha. `crm-apk` → la ficha `crm`.
        prisma.clientApp.findFirst({
            where: { clientId: { in: [app, app.replace(/-apk$/, "")] }, dispositivosUrl: { not: null } },
            select: { dispositivosUrl: true },
        }),
    ]);

    const truncada = filas.length > TOPE;
    const mostradas = truncada ? filas.slice(0, TOPE) : filas;
    const personas = await prisma.user.findMany({
        where: { id: { in: [...new Set(mostradas.flatMap((d) => [d.userId, ...d.personas.map((p) => p.userId)]))] } },
        select: { id: true, name: true },
    });
    const nombres = new Map(personas.map((p) => [p.id, p.name]));
    // Un aparato es UNO aunque esté en varias aplicaciones: aquí se ve en cuáles más está.
    const otras = await prisma.dispositivoApp.findMany({
        where: { dispositivoId: { in: mostradas.map((d) => d.dispositivoId) }, clientId: { not: app } },
        select: { dispositivoId: true, clientId: true },
    });
    const tambienEn = new Map<string, string[]>();
    for (const o of otras) tambienEn.set(o.dispositivoId, [...(tambienEn.get(o.dispositivoId) ?? []), o.clientId]);
    const ahora = new Date();

    return (
        <DispositivosTabla
            pestanas={tabs}
            app={app}
            sucursal={sucursal}
            sucursales={sucursales.flatMap((s) => (s.sucursal ? [s.sucursal] : []))}
            filas={mostradas.map((d) => aFila({ ...d.dispositivo, ...d, tambienEn: tambienEn.get(d.dispositivoId) }, nombres, plantilla?.dispositivosUrl ?? null, ahora))}
            truncada={truncada}
            tope={TOPE}
        />
    );
}
