import { getCurrentUser } from "@/server/auth.server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ProfileContent } from "@/components/profile/profile-content";

export const dynamic = "force-dynamic";

/**
 * Mi cuenta.
 *
 * Antes esto traía las reservas y las facturas de la persona para calcular
 * "estancias activas", "completadas" y "gasto total" — del negocio de
 * alojamientos del que salió este código. Aquí no hay ni reservas ni facturas:
 * lo que define a alguien es en qué sucursales trabaja y con qué rol.
 *
 * Tampoco redirige ya al panel. Un Super Admin también tiene cuenta propia y
 * tiene que poder ver la suya sin que se lo lleven a otra pantalla.
 */
export default async function ProfilePage() {
    const { data: user } = await getCurrentUser();
    if (!user) redirect("/");

    /**
     * El rol de verdad, no uno supuesto.
     *
     * La pantalla escribía "Super Admin" a fuego en cuanto isSystemAdmin era cierto, así
     * que quien tiene DESARROLLADOR —que está por encima— se veía etiquetado como algo
     * que no es. Y no es un detalle cosmético: la etiqueta del perfil es donde uno
     * comprueba con qué permisos está entrando.
     */
    const conRol = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
            // El teléfono lo completa la persona en Configurar perfil; aquí se enseña.
            phone: true,
            defaultRole: {
                select: {
                    name: true,
                    description: true,
                },
            },
        },
    });


    const miembros = await prisma.member.findMany({
        where: { userId: user.id },
        select: {
            organization: { select: { name: true, metadata: true } },
            memberRoles: { select: { role: { select: { name: true } } } },
        },
        orderBy: { createdAt: "asc" },
    });

    const pertenencias = miembros.map((m) => {
        // El código de la sucursal (CAM, HOL…) va en `metadata` como JSON. Es lo
        // que la gente reconoce de un vistazo, mucho antes que el nombre largo.
        let codigo: string | null = null;
        try {
            codigo = JSON.parse(m.organization.metadata ?? "{}").codigo ?? null;
        } catch {
            codigo = null;
        }
        return {
            sucursal: m.organization.name,
            codigo,
            roles: m.memberRoles.map((r) => r.role.name),
        };
    });

    return (
        <ProfileContent
            user={{ ...user, phone: conRol?.phone ?? null }}
            pertenencias={pertenencias}
            rol={
                conRol?.defaultRole
                    ? {
                          name: conRol.defaultRole.name,
                          description: conRol.defaultRole.description,
                      }
                    : null
            }
        />
    );
}
