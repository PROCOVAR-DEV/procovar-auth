"use client";

import { useTranslations } from "next-intl";
import { useFullUser } from "@/components/full-user-provider";
import { ProfileEditor } from "./profile-editor";
import { SecuritySection } from "./security-section";
import { NotificationsSection } from "./notifications-section";

/**
 * Configurar perfil: los datos de la persona, su contraseña y sus avisos.
 *
 * Ya no es una pantalla aparte (`/profile/me`): es la parte de abajo de Mi cuenta, para
 * que lo que uno completa aquí salga arriba, en el resumen. El `id` es el ancla a la que
 * apunta el botón del resumen y la redirección de `/profile/me`.
 *
 * Antes esto arrancaba con un asistente paso a paso que preguntaba los datos de
 * uno en uno. Un asistente sirve para quien entra por primera vez a un producto
 * y no sabe qué se espera de él; aquí entra gente de la casa a cambiar su
 * teléfono. El formulario, entero y de una vez, es más rápido para eso.
 */
export function MiPerfilSecciones() {
    const t = useTranslations();
    const { user } = useFullUser();

    return (
        // `scroll-mt-20`: la cabecera fija mide 3.5rem y taparía el título al saltar al ancla.
        <section
            id="configurar-perfil"
            aria-labelledby="configurar-perfil-titulo"
            className="scroll-mt-20 space-y-5 border-t border-pv-trazo-tenue pt-6"
        >
            <h2 id="configurar-perfil-titulo" className="pv-titulo text-xl">
                {t("nav.settings")}
            </h2>
            {/* El editor toma sus valores iniciales de `user` al montarse. Al entrar
                directo a /profile el usuario aún no ha llegado y quedaría con los
                campos vacíos: con la `key` se vuelve a montar cuando llega. */}
            <ProfileEditor key={user?.id ?? "cargando"} />
            <SecuritySection />
            <NotificationsSection />
        </section>
    );
}
