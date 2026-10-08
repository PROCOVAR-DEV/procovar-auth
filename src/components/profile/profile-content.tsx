"use client";

import Link from "next/link";
import { Icon } from "@iconify/react";
import { useTranslations } from "next-intl";
import { Icons } from "@/components/icons/iconify";
import { MiPerfilSecciones } from "@/components/profile/personal/mi-perfil-secciones";

interface User {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    emailVerified: boolean;
    /** Lo que la persona completa en Configurar perfil; vacío si no lo ha puesto. */
    phone?: string | null;
    isSystemAdmin?: boolean;
    createdAt: Date;
}

export interface Pertenencia {
    sucursal: string;
    codigo: string | null;
    roles: string[];
}

interface ProfileContentProps {
    user: User;
    /** Las sucursales de esta persona y el rol que tiene en cada una. */
    pertenencias: Pertenencia[];
    /** El rol de verdad, con su descripción. Null si nadie le asignó ninguno. */
    rol: { name: string; description: string | null } | null;
}

/**
 * Mi cuenta.
 *
 * Enseña lo único que aquí importa de una persona: quién es y **dónde puede
 * trabajar**. Antes enseñaba reservas activas, estancias completadas y el gasto
 * total en euros: eran del producto de alojamientos del que salió este código.
 * En Procovar nadie gasta euros ni tiene estancias.
 *
 * "Dónde puede trabajar" no es un adorno: es la primera pregunta cuando algo no
 * deja hacer algo, y hasta ahora había que ir a buscarla al panel.
 */
export function ProfileContent({ user, pertenencias, rol }: ProfileContentProps) {
    const t = useTranslations();
    const inicial = user.name?.[0]?.toUpperCase() || "?";

    /**
     * Qué poner en la etiqueta del rol.
     *
     * El rol asignado manda sobre `isSystemAdmin`. Antes se escribía "Super Admin" en
     * cuanto esa bandera era cierta, y quien tiene DESARROLLADOR —que está por encima—
     * se veía etiquetado como algo que no es. Aquí es donde uno comprueba con qué
     * permisos entra, así que decir el que no es resulta peor que no decir ninguno.
     */
    const etiquetaRol = rol?.name ?? (user.isSystemAdmin ? "SUPER ADMIN" : null);

    return (
        <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
            <div>
                <p className="pv-rotulo">{t("navbar.section")}</p>
                <h1 className="pv-titulo text-2xl">{t("profile.title")}</h1>
            </div>

            <div className="pv-ficha">
                <div className="flex flex-wrap items-center gap-4 p-5">
                    {/* El avatar es la única cosa redonda del sistema: es una cara. */}
                    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-pv-azul text-xl font-bold text-white">
                        {user.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={user.image}
                                alt=""
                                className="size-14 object-cover"
                                referrerPolicy="no-referrer"
                            />
                        ) : (
                            inicial
                        )}
                    </div>

                    <div className="min-w-0 flex-1">
                        <h2 className="pv-titulo truncate text-lg">{user.name}</h2>
                        <p className="truncate text-sm text-pv-tinta-suave">{user.email}</p>
                        {user.phone && (
                            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-pv-tinta-suave">
                                <Icon icon="lucide:phone" className="size-3.5 shrink-0" aria-hidden />
                                <span className="truncate">{user.phone}</span>
                            </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {etiquetaRol && (
                                <span className="pv-etiqueta pv-etiqueta-azul">{etiquetaRol}</span>
                            )}
                            <span
                                className={
                                    "pv-etiqueta " +
                                    (user.emailVerified ? "pv-etiqueta-visto" : "pv-etiqueta-ambar")
                                }
                            >
                                {user.emailVerified
                                    ? t("profile.emailVerified")
                                    : t("profile.emailNotVerified")}
                            </span>
                        </div>
                    </div>

                    {/* Ancla de esta misma página: configurar el perfil ya no es otra pantalla. */}
                    <a
                        href="#configurar-perfil"
                        className="pv-toque inline-flex shrink-0 items-center gap-2 bg-pv-azul px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pv-azul-hondo"
                    >
                        <Icons.userCircle className="size-4" />
                        <span className="hidden sm:inline">{t("nav.settings")}</span>
                        <Icon icon="lucide:chevron-down" className="size-4" aria-hidden />
                    </a>
                </div>
            </div>

            {/*
                Mosaico y no una lista.
                
                Antes esto era una sola ficha con una frase dentro y el resto de la
                pantalla en blanco. Las cosas que se miran aquí son independientes entre
                sí —qué rol tengo, dónde trabajo, a dónde voy— y en una lista vertical
                cada una obliga a bajar la vista para descubrir que la siguiente cabía al
                lado.
            */}
            <div className="grid gap-4 sm:grid-cols-2">
                {/* Qué puedo hacer. Va primero porque es lo que se viene a comprobar. */}
                <div className="pv-ficha flex flex-col">
                    <div className="pv-ficha-cabecera">
                        <Icon icon="lucide:shield-check" className="size-4 text-pv-tinta-suave" aria-hidden />
                        <h2 className="text-sm font-semibold">{t("profile.myRole")}</h2>
                    </div>
                    <div className="flex-1 px-4 py-4">
                        {etiquetaRol ? (
                            <>
                                <p className="pv-codigo text-lg font-semibold text-pv-azul">
                                    {etiquetaRol}
                                </p>
                                {/* La descripción del rol, aquí y no escondida en el panel
                                    de permisos: es donde uno se pregunta qué alcanza. */}
                                <p className="mt-2 text-sm leading-relaxed text-pv-tinta-suave">
                                    {rol?.description ?? t("profile.superAdminScope")}
                                </p>
                            </>
                        ) : (
                            <p className="text-sm text-pv-tinta-suave">{t("profile.noRole")}</p>
                        )}
                    </div>
                </div>

                {/* Dónde trabajo. */}
                <div className="pv-ficha flex flex-col">
                    <div className="pv-ficha-cabecera">
                        <Icon icon="lucide:building-2" className="size-4 text-pv-tinta-suave" aria-hidden />
                        <h2 className="text-sm font-semibold">{t("profile.myBranches")}</h2>
                    </div>

                    {user.isSystemAdmin && pertenencias.length === 0 ? (
                        // Quien manda en todas no pertenece a ninguna. Decirle "no tienes
                        // ninguna" sería mentirle al que más puede.
                        <div className="flex-1 px-4 py-4">
                            <p className="pv-codigo text-lg font-semibold text-pv-azul">
                                {t("cuenta.todasLasSucursales")}
                            </p>
                            <p className="mt-2 text-sm leading-relaxed text-pv-tinta-suave">
                                {t("profile.superAdminScope")}
                            </p>
                        </div>
                    ) : pertenencias.length === 0 ? (
                        <p className="flex-1 px-4 py-4 text-sm text-pv-tinta-suave">
                            {t("profile.noBranches")}
                        </p>
                    ) : (
                        <ul className="flex-1 divide-y divide-pv-trazo-tenue">
                            {pertenencias.map((p) => (
                                <li key={p.sucursal} className="flex flex-wrap items-center gap-2 px-4 py-3">
                                    {p.codigo && (
                                        <span className="pv-etiqueta pv-etiqueta-gris">{p.codigo}</span>
                                    )}
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                        {p.sucursal}
                                    </span>
                                    <div className="flex flex-wrap gap-1.5">
                                        {p.roles.map((r) => (
                                            <span key={r} className="pv-etiqueta pv-etiqueta-azul">
                                                {r}
                                            </span>
                                        ))}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {/* A dónde ir desde aquí. Enlaces, no adornos: cada uno lleva a algo que se
                hace de verdad desde el perfil. */}
            <div className="grid gap-3 sm:grid-cols-2">
                {[
                    // "Mi perfil" no se repite: ya tiene su botón arriba, en la ficha de
                    // la persona. Dos caminos al mismo sitio en la misma pantalla no dan
                    // opciones, hacen dudar de si llevan a lo mismo.
                    //
                    // Los avisos tampoco están aquí: se fueron a la campana de la barra,
                    // que es donde se ven llegar sin tener que venir a buscarlos.
                    { href: "/profile/notifications", icono: "lucide:inbox", titulo: t("profile.notificationsTitle"), pie: t("profile.notificationsHint") },
                    { href: "/logout", icono: "lucide:log-out", titulo: t("nav.logOut"), pie: t("profile.logoutHint") },
                ].map((a) => (
                    <Link
                        key={a.href}
                        href={a.href}
                        className="pv-ficha flex items-start gap-3 p-4 transition-colors hover:bg-pv-azul/5"
                    >
                        <Icon icon={a.icono} className="mt-0.5 size-4 shrink-0 text-pv-azul" aria-hidden />
                        <span className="min-w-0">
                            <span className="block text-sm font-semibold">{a.titulo}</span>
                            <span className="mt-0.5 block text-xs text-pv-tinta-suave">{a.pie}</span>
                        </span>
                    </Link>
                ))}
            </div>

            <MiPerfilSecciones />
        </div>
    );
}
