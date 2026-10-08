import { redirect } from "next/navigation";

/**
 * Configurar perfil ya no es una pantalla aparte: vive dentro de Mi cuenta
 * (`/profile`, sección `#configurar-perfil`). Se deja la ruta solo para no romper
 * los enlaces guardados.
 */
export default function MiPerfilPage() {
    redirect("/profile#configurar-perfil");
}
