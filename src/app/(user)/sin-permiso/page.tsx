import Link from "next/link";
import { Icon } from "@iconify/react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/server/auth.server";
import { NOMBRE_DEL_CLIENTE } from "@/lib/puerta-de-entrada";

/**
 * A donde se lleva a quien intentó entrar a una aplicación para la que no tiene la llave
 * `<app>.entrar` (ver `@/lib/puerta-de-entrada`).
 *
 * Es una PARADA, no un paso del flujo: la galleta de flujo ya se borró en
 * `/api/auth/callback`, y esta pantalla no lanza nada ni redirige a ninguna aplicación.
 * Lo único que ofrece es volver a `/`, que enseña las aplicaciones que sí le tocan.
 *
 * El nombre sale de la lista de Accesos y no de la dirección: `?app=` es texto de quien
 * escribió el enlace, y pintarlo tal cual sería dejar que cualquiera ponga una frase suya
 * en una pantalla nuestra.
 */
export default async function SinPermisoPage({
    searchParams,
}: {
    searchParams: Promise<{ app?: string }>;
}) {
    const { data: user } = await getCurrentUser();
    if (!user) redirect("/");

    const { app } = await searchParams;
    const t = await getTranslations("sinPermiso");
    const nombre = app && Object.hasOwn(NOMBRE_DEL_CLIENTE, app) ? NOMBRE_DEL_CLIENTE[app] : null;

    return (
        <div className="mx-auto max-w-5xl px-4 py-8">
            <div className="max-w-xl space-y-4">
                <p className="pv-rotulo">{t("rotulo")}</p>
                <h1 className="pv-titulo flex items-start gap-3 text-2xl">
                    <Icon icon="lucide:lock" className="mt-1 size-6 shrink-0 text-pv-cuno" aria-hidden />
                    <span>{nombre ? t("titulo", { app: nombre }) : t("tituloGenerico")}</span>
                </h1>
                <p className="text-sm text-pv-tinta-suave">{t("detalle")}</p>
                <Link
                    href="/"
                    className="pv-toque inline-flex items-center gap-2 bg-pv-azul px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pv-azul-hondo"
                >
                    <Icon icon="lucide:arrow-left" className="size-4 shrink-0" aria-hidden />
                    {t("volver")}
                </Link>
            </div>
        </div>
    );
}
