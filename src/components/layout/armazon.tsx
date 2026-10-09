"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useLinkStatus } from "next/link";
import { Icon } from "@iconify/react";
import { useTranslations, useLocale } from "next-intl";
import { setLocale } from "@/server/locale.server";
import { NotificationBell } from "@/components/layout/navbar/notification-bell";
import { apartadoActivo } from "@/components/layout/apartado-activo";
import type { Locale } from "@/i18n/config";

export interface Persona {
    nombre: string;
    correo: string;
    esSuperAdmin: boolean;
    /** Código de la sucursal en la que trabaja, o "TODAS" para el Super Admin. */
    alcance: string | null;
    /** Si lleva alguna sucursal, para enseñarle su panel. */
    llevaSucursal: boolean;
}

/**
 * El armazón de Procovar.
 *
 * # Por qué una barra lateral y no una de arriba
 *
 * Lo que había era una barra superior con el menú escondido dentro del avatar,
 * más una fila de pestañas debajo: dos niveles de navegación, ninguno visible de
 * un vistazo, y la mitad de las opciones enterradas a dos clics. Es la forma de
 * una web que vende a desconocidos, donde lo que importa es el contenido y la
 * navegación estorba.
 *
 * Esto es lo contrario: una herramienta de trabajo donde se salta de las
 * sucursales a la gente y de la gente a los permisos veinte veces al día. Todo
 * está a un clic y a la vista, siempre en el mismo sitio.
 *
 * # El alcance, arriba y fijo
 *
 * En la banda superior va el marco con la sucursal. No es adorno: casi todos los
 * líos de este sistema salen de no saber con qué alcance se está mirando.
 *
 * # En el móvil
 *
 * La barra se recoge y sale con el botón. No se convierte en una fila de iconos
 * abajo: los apartados tienen nombres que hay que leer, y un icono de "roles y
 * permisos" no lo adivina nadie.
 */

interface Apartado {
    href: string;
    icono: string;
    texto: string;
    /** Solo para el Super Admin. */
    soloGlobal?: boolean;
    /** Solo para quien lleva alguna sucursal. */
    soloSucursal?: boolean;
}

/**
 * El icono del enlace, que se vuelve girador mientras esa ruta está cargando.
 *
 * En el App Router, al pulsar un enlace no pasa NADA visible hasta que el servidor
 * termina de resolver la página. Con una conexión lenta eso son segundos en los que la
 * pantalla no se mueve, y la gente vuelve a pulsar creyendo que no registró el clic.
 *
 * `useLinkStatus` sólo funciona dentro de un `<Link>`, y da el estado de ESE enlace en
 * concreto — por eso el aviso sale justo en el apartado que se pulsó y no en un
 * indicador general que no dice a dónde se va.
 *
 * Es la mitad rápida de la solución: se ve en el mismo instante del clic. La otra mitad
 * son los loading.tsx, que pintan el esqueleto de la página que viene.
 */
function IconoDelEnlace({ icono }: { icono: string }) {
    const { pending } = useLinkStatus();

    return (
        <Icon
            icon={pending ? "lucide:loader-circle" : icono}
            className={`size-4 shrink-0${pending ? " animate-spin" : ""}`}
            aria-hidden
        />
    );
}

export function Armazon({ persona, children }: { persona: Persona; children: React.ReactNode }) {
    const t = useTranslations();
    const ruta = usePathname();
    const idioma = useLocale() as Locale;
    const [abierta, setAbierta] = useState(false);

    // Los apartados de administración van primero y solo los ve quien manda; los
    // dos últimos los ve TODO el mundo.
    //
    // "Mi cuenta" (que lleva dentro Configurar perfil) está aquí, en la navegación, y no solo
    // colgando del nombre de abajo. Antes la única forma de llegar al perfil era
    // pulsar el nombre en la esquina, que no parece un enlace: quien no es
    // administrador entraba, no veía ningún apartado y se quedaba sin saber a
    // dónde ir.
    const APARTADOS: Apartado[] = [
        // INICIO para TODO el mundo (Jose, 08/10/2026): la pantalla «A dónde ir», con todas las aplicaciones
        // y las que no tienes, apagadas. Antes sólo llegaba quien tecleaba la raíz o pulsaba el logotipo.
        { href: "/", icono: "lucide:layout-grid", texto: t("rail.inicio") },
        { href: "/dashboard/organizations", icono: "lucide:building-2", texto: t("rail.sucursales"), soloGlobal: true },
        { href: "/profile/org", icono: "lucide:building-2", texto: t("rail.miSucursal"), soloSucursal: true },
        { href: "/dashboard/users", icono: "lucide:users", texto: t("rail.personas"), soloGlobal: true },
        { href: "/dashboard/permissions", icono: "lucide:shield-check", texto: t("rail.permisos"), soloGlobal: true },
        { href: "/dashboard/auditoria", icono: "lucide:scroll-text", texto: t("rail.auditoria"), soloGlobal: true },
        { href: "/apikeys", icono: "lucide:key-round", texto: t("rail.aplicaciones"), soloGlobal: true },
        { href: "/profile", icono: "lucide:circle-user", texto: t("rail.miCuenta") },
    ];

    const visibles = APARTADOS.filter((a) => {
        if (a.soloGlobal) return persona.esSuperAdmin;
        if (a.soloSucursal) return !persona.esSuperAdmin && persona.llevaSucursal;
        return true;
    });

    // Uno solo encendido: el de href más largo (ver `apartado-activo.ts`).
    const activo = apartadoActivo(
        ruta,
        visibles.map((a) => a.href),
    );

    const barra = (
        <div className="pv-rail flex h-full w-56 shrink-0 flex-col">
            <div className="flex h-14 items-center gap-2.5 px-4">
                <Link href="/" className="flex items-center gap-2.5" onClick={() => setAbierta(false)}>
                    <Image src="/logo.png" alt="Procovar" width={150} height={30} className="h-5 w-auto object-contain" />
                </Link>
            </div>

            <nav className="mt-2 flex-1 overflow-y-auto py-1">
                {visibles.map((a) => (
                    <Link
                        key={a.href}
                        href={a.href}
                        onClick={() => setAbierta(false)}
                        className="pv-rail-enlace"
                        data-activo={a.href === activo}
                        aria-current={a.href === activo ? "page" : undefined}
                    >
                        <IconoDelEnlace icono={a.icono} />
                        <span className="truncate">{a.texto}</span>
                    </Link>
                ))}
            </nav>

            <div className="border-t border-white/10 p-3">
                <Link
                    href="/profile"
                    onClick={() => setAbierta(false)}
                    className="block min-w-0 rounded-none px-1 py-1 transition-colors hover:bg-white/[0.06]"
                >
                    <p className="truncate text-sm font-semibold text-white">{persona.nombre}</p>
                    <p className="truncate text-xs text-white/45">{persona.correo}</p>
                </Link>
                <Link
                    href="/logout"
                    onClick={() => setAbierta(false)}
                    className="mt-1.5 flex items-center gap-2 px-1 py-1.5 text-xs font-semibold uppercase tracking-wider text-white/55 transition-colors hover:text-white"
                >
                    <Icon icon="lucide:log-out" className="size-3.5" aria-hidden />
                    {t("nav.logOut")}
                </Link>
            </div>
        </div>
    );

    return (
        <div className="flex min-h-svh bg-pv-papel">
            {/* Fija en el escritorio */}
            {/* `self-start` es lo que hace que `sticky` funcione de verdad.
                  Sin él, al ser hijo de un flex con `align-items: stretch`, la barra
                  se estira hasta la altura de TODO el contenido: su caja abarca el
                  scroll entero, así que no hay nada contra lo que pegarse y baja con
                  la página. Con `self-start` mide una pantalla y se queda fija. */}
            <aside className="sticky top-0 self-start hidden h-svh lg:block">{barra}</aside>

            {/* Cajón en el móvil */}
            {abierta && (
                <>
                    <button
                        type="button"
                        aria-label={t("rail.cerrarMenu")}
                        onClick={() => setAbierta(false)}
                        className="fixed inset-0 z-40 bg-black/40 lg:hidden"
                    />
                    <aside className="fixed inset-y-0 left-0 z-50 h-svh lg:hidden">{barra}</aside>
                </>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-pv-trazo bg-pv-papel/95 px-4 backdrop-blur">
                    <button
                        type="button"
                        onClick={() => setAbierta(true)}
                        aria-label={t("rail.abrirMenu")}
                        className="pv-toque -ml-1 flex size-9 items-center justify-center text-pv-tinta lg:hidden"
                    >
                        <Icon icon="lucide:menu" className="size-5" aria-hidden />
                    </button>

                    {persona.alcance && (
                        <span className="pv-marco">
                            <span className="pv-rotulo">{t("cuenta.alcance")}</span>
                            <span className="pv-codigo font-semibold text-pv-azul">{persona.alcance}</span>
                        </span>
                    )}

                    <div className="ml-auto flex items-center gap-1">
                        {/*
                            Los avisos, aquí y siempre a la vista.
                            
                            El componente existía desde hace tiempo y no estaba enchufado
                            en ningún sitio: se escribió y se quedó sin colocar, así que
                            las notificaciones no se veían en ninguna pantalla.
                            
                            Va en la barra y no en una ficha del perfil porque un aviso
                            sirve para enterarse cuando llega, no cuando a uno se le
                            ocurre ir a mirarlo. Escondido en el perfil, quien no entra
                            ahí no se entera nunca.
                        */}
                        <NotificationBell />

                        {/* El idioma, sin desplegable: son dos. Un menú para elegir
                            entre dos cosas es un clic de más. */}
                        {(["es", "en"] as Locale[]).map((l) => (
                            <button
                                key={l}
                                type="button"
                                onClick={() => void setLocale(l)}
                                aria-current={l === idioma ? "true" : undefined}
                                className={
                                    "px-2 py-1 text-xs font-semibold uppercase tracking-wider transition-colors " +
                                    (l === idioma
                                        ? "text-pv-azul underline underline-offset-4"
                                        : "text-pv-tinta-suave hover:text-pv-tinta")
                                }
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                </header>

                <main className="min-w-0 flex-1">{children}</main>
            </div>
        </div>
    );
}
