import Link from "next/link";
import { Icon } from "@iconify/react";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import type { ProfileRole } from "@/lib/role-resolver";
import {
    APLICACIONES_DE_LA_CASA,
    accesoDe,
    aplicacionesConAcceso,
    type Destino,
} from "@/lib/aplicaciones-visibles";

interface AccountViewProps {
    user: { id: string; name: string; email: string; image?: string | null; isSystemAdmin?: boolean };
    role: ProfileRole;
}

/**
 * Lo primero que ve alguien que ya tiene la sesión abierta.
 *
 * Antes era una tarjeta con una cabecera en degradado morado y un "bienvenido de
 * nuevo" enorme, y debajo tres botones de los que dos ya no llevaban a ninguna
 * parte —"dashboard propietario", "mi perfil personal"— porque eran del producto
 * del que salió este código.
 *
 * Ahora responde la única pregunta que trae quien llega aquí: **a dónde voy**.
 * Se enseñan las aplicaciones a las que esta persona puede entrar, y su sucursal
 * arriba, porque de eso depende lo que verá cuando llegue. Cuáles son sale de sus
 * llaves de entrada, en el servidor (ver `@/lib/aplicaciones-visibles`).
 *
 * No hay saludo. Se entra a trabajar, no de visita.
 */

export async function AccountView({ user, role }: AccountViewProps) {
    const t = await getTranslations();

    const [miembros, acceso] = await Promise.all([
        prisma.member.findMany({
            where: { userId: user.id },
            select: { organization: { select: { name: true, slug: true } } },
            orderBy: { createdAt: "asc" },
        }),
        accesoDe(user.id, user.isSystemAdmin ?? false),
    ]);
    const aplicaciones = aplicacionesConAcceso(APLICACIONES_DE_LA_CASA, acceso);

    // El alcance, arriba y siempre: de él depende lo que se verá al llegar a
    // cualquiera de las aplicaciones.
    const alcance = user.isSystemAdmin
        ? { codigo: "TODAS", nombre: t("cuenta.todasLasSucursales") }
        : miembros[0]
          ? { codigo: miembros[0].organization.slug.toUpperCase(), nombre: miembros[0].organization.name }
          : null;

    // Las pantallas de Accesos mismas: no son una aplicación con llave de entrada.
    const gestion: Omit<Destino, "clientId">[] = [];
    if (user.isSystemAdmin) {
        gestion.push({
            href: "/dashboard/organizations",
            icono: "lucide:building-2",
            titulo: t("cuenta.panel"),
            descripcion: t("cuenta.panelDesc"),
        });
    } else if (role === "org-full") {
        gestion.push({
            href: "/profile/org",
            icono: "lucide:building-2",
            titulo: t("orgPage.title"),
            descripcion: t("cuenta.miSucursalDesc"),
        });
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="pv-rotulo">{t("cuenta.rotulo")}</p>
                    <h1 className="pv-titulo mt-1 text-2xl">{user.name}</h1>
                    <p className="mt-0.5 text-sm text-pv-tinta-suave">{user.email}</p>
                </div>

                {alcance && (
                    <span className="pv-marco">
                        <span className="pv-rotulo">{t("cuenta.alcance")}</span>
                        <span className="pv-codigo font-semibold text-pv-azul">{alcance.codigo}</span>
                    </span>
                )}
            </div>

            <div>
                <h2 className="pv-rotulo mb-2">{t("cuenta.aplicaciones")}</h2>
                {gestion.length === 0 && !aplicaciones.some((a) => a.permitida) && (
                    <p className="mb-3 text-sm text-pv-tinta-suave">{t("cuenta.sinAplicaciones")}</p>
                )}
                <div className="grid gap-px bg-pv-trazo-tenue sm:grid-cols-2 lg:grid-cols-3">
                    {[...gestion.map((g) => ({ ...g, permitida: true })), ...aplicaciones].map((d) => d.permitida ? (
                        <Link
                            key={d.href}
                            href={d.href}
                            target={d.externo ? "_blank" : undefined}
                            rel={d.externo ? "noopener noreferrer" : undefined}
                            className="group flex items-start gap-3 bg-pv-blanco p-4 transition-colors hover:bg-pv-azul-tinte"
                        >
                            <Icon
                                icon={d.icono}
                                className="mt-0.5 size-5 shrink-0 text-pv-tinta-suave transition-colors group-hover:text-pv-azul"
                                aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                    <span className="font-semibold">{d.titulo}</span>
                                    {d.externo && (
                                        <Icon
                                            icon="lucide:arrow-up-right"
                                            className="size-3.5 shrink-0 text-pv-tinta-suave"
                                            aria-hidden
                                        />
                                    )}
                                </span>
                                <span className="mt-0.5 block text-sm text-pv-tinta-suave">
                                    {d.descripcion}
                                </span>
                            </span>
                        </Link>
                    ) : (
                        // Sin permiso: se ENSEÑA apagada, no se esconde (Jose, 08/10/2026). No es un
                        // enlace —nada que pulsar— y dice por qué, también a quien usa lector de pantalla.
                        <div
                            key={d.href}
                            aria-disabled="true"
                            title={t("cuenta.sinAcceso")}
                            className="flex cursor-not-allowed items-start gap-3 bg-pv-blanco p-4 opacity-45"
                        >
                            <Icon icon={d.icono} className="mt-0.5 size-5 shrink-0 text-pv-tinta-suave" aria-hidden />
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                    <span className="font-semibold">{d.titulo}</span>
                                    <Icon icon="lucide:lock" className="size-3.5 shrink-0 text-pv-tinta-suave" aria-hidden />
                                    <span className="sr-only">{t("cuenta.sinAcceso")}</span>
                                </span>
                                <span className="mt-0.5 block text-sm text-pv-tinta-suave">{d.descripcion}</span>
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-pv-trazo-tenue pt-4 text-sm">
                <Link href="/profile" className="text-pv-azul hover:underline">
                    {t("nav.profile")}
                </Link>
                <Link href="/profile/me" className="text-pv-azul hover:underline">
                    {t("nav.settings")}
                </Link>
                <Link href="/logout" className="ml-auto text-pv-cuno hover:underline">
                    {t("nav.logOut")}
                </Link>
            </div>
        </div>
    );
}
