"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/server/auth.server";
import { revalidatePath } from "next/cache";
import { getRedis } from "@/lib/redis";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { altaPersona } from "@/lib/alta-persona";
import { rbacEnSucursal, rolesEnSucursal } from "@/rbac/en-sucursal";
import { can } from "@/rbac/can";
import { puedeRepartirRol } from "@/rbac/escalafon";
import { systemRolePermissionKeys } from "@/rbac/system-roles";
import { hashPassword } from "better-auth/crypto";
import { cerrarTodasLasFamiliasDe } from "@/lib/apk-tokens";
import { esSuperAdmin } from "@/lib/alta-persona";
import {
    personasConRol,
    personasDeLaSucursal,
    publicarPermisosCambiados,
    publicarSesionCerrada,
} from "@/lib/eventos-de-sesion";
import { pierdeLlaves, sucursalPierdeAcceso } from "@/lib/pierde-acceso";

async function requireAdmin() {
    const { data: user } = await getCurrentUser();
    if (!user?.isSystemAdmin) throw new Error("No autorizado");
    return user;
}

/**
 * Quien pide esto, ¿puede hacerlo EN ESTA SUCURSAL?
 *
 * El Super Admin puede en todas. Cualquier otro solo en las SUYAS —donde está
 * dado de alta—, y ni siquiera en todas ellas: hace falta además el permiso
 * concreto. Esto es lo que impide que un Administrador de Camagüey toque la
 * gente de Holguín cambiando un identificador en la petición.
 *
 * Usa `rbacEnSucursal` y no `resolveRbac` a secas, y ahí está la diferencia: el
 * segundo suma los permisos del rol de la persona AUNQUE no sea miembro de esa
 * sucursal, así que mandando el id de Holguín la comprobación decía que sí. El
 * alcance tiene que salir de quién pregunta, no del parámetro.
 */
async function exigirEnSucursal(organizationId: string, permiso: string) {
    const { data: user } = await getCurrentUser();
    if (!user) throw new Error("No autorizado");
    const rbac = await rbacEnSucursal(user.id, organizationId);
    if (!can(rbac, permiso)) {
        // Sin sucursal no hay membresía que dé permisos: esto solo lo puede hacer
        // quien manda en todas. Decirlo así, y no "en esta sucursal", que sin
        // sucursal no se entiende de qué habla.
        throw new Error(organizationId
            ? "No puedes hacer esto en esta sucursal."
            : "Esto solo lo puede hacer un Super Admin.");
    }
    return user;
}

/**
 * Nadie reparte un rol por encima del suyo, ni el suyo mismo.
 *
 * Es la segunda mitad de este encargo, y la que no se podía dejar a la pantalla:
 * que el desplegable no ofrezca SUPER ADMIN es comodidad; esto es lo que lo
 * impide cuando la llamada llega a mano con el id que sea.
 *
 * Dice el porqué en el mensaje —"sólo los de debajo"— en vez de un "no puedes" a
 * secas: quien reparte accesos necesita saber si es que le falta un permiso o es
 * que ese rol nunca va a poder darlo.
 *
 * Devuelve el error, o `null` si puede.
 */
async function exigirRolRepartible(
    actorId: string,
    organizationId: string | null | undefined,
    roles: readonly { name: string; claves: readonly string[] }[],
): Promise<string | null> {
    const rbac = await rbacEnSucursal(actorId, organizationId);
    const mios = await rolesEnSucursal(actorId, organizationId);
    for (const rol of roles) {
        if (!puedeRepartirRol(rbac, mios, rol)) {
            return `No puedes dar el rol ${rol.name}: sólo puedes repartir los que están por debajo del tuyo.`;
        }
    }
    return null;
}

/** Las claves de permiso de un rol tal y como las devuelve Prisma. */
function clavesDe(rol: { permissions: { permission: { key: string } | null }[] }): string[] {
    return rol.permissions
        .map((p) => p.permission?.key)
        .filter((k): k is string => Boolean(k));
}

/**
 * Dar de alta a una persona en una sucursal, con su rol.
 *
 * Se crea con contraseña, no por invitación: ver el porqué en `altaPersona`.
 */
export async function anadirPersona(datos: {
    /** Vacío al abrir una cuenta: la sucursal se da después, en Sucursales. */
    organizationId?: string;
    nombre: string;
    usuario?: string;
    email?: string;
    password: string;
    roleId: string;
    /** Su código de vendedor, si vende. Vendedor y usuario son la misma persona. */
    codigoVendedor?: string;
}): Promise<{ error?: string; yaExistia?: boolean }> {
    try {
        const actor = await exigirEnSucursal(datos.organizationId ?? "", "member.invite");

        // Nadie reparte un rol por encima del suyo: si no, un Administrador se
        // asciende creando una segunda cuenta con rol SUPER ADMIN y entrando con
        // ella. El techo se mide EN la sucursal que se pide, que es donde ya se
        // comprobó que puede dar de alta.
        const rol = await prisma.role.findUnique({
            where: { id: datos.roleId },
            select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
        });
        if (!rol) return { error: "Ese rol no existe." };
        const veto = await exigirRolRepartible(actor.id, datos.organizationId, [
            { name: rol.name, claves: clavesDe(rol) },
        ]);
        if (veto) return { error: veto };

        const res = await altaPersona(datos);
        if (res.error) return { error: res.error };

        audit({
            action: "member.create",
            resource: res.memberId,
            userId: actor.id,
            meta: {
                sucursal: datos.organizationId || null,
                personaCreada: res.userId,
                cuentaNueva: !res.yaExistia,
            },
        });
        // Un alta sólo da acceso: no se publica nada (ver `lib/pierde-acceso.ts`). Si no, quien puede
        // dar de alta podría echar de todas las aplicaciones a quien quisiera "dándole de alta".
        revalidatePath("/dashboard");
        return { yaExistia: res.yaExistia };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * Añadir a una sucursal a alguien que YA tiene cuenta.
 *
 * Crear la persona y meterla en una sucursal son dos cosas distintas y se hacen en
 * dos sitios distintos: la cuenta se abre en Personas, y aquí solo se dice en qué
 * sucursales trabaja. Antes esta pantalla pedía nombre y contraseña, o sea que
 * obligaba a crear una cuenta para poder mover a alguien a otra sucursal.
 */
export async function agregarMiembro(datos: {
    organizationId: string;
    userId: string;
    /** Opcional: sin él se hereda el que la persona ya tiene. */
    roleId?: string;
}): Promise<{ error?: string; yaEstaba?: boolean; rol?: string }> {
    try {
        const actor = await exigirEnSucursal(datos.organizationId, "member.invite");

        // El rol NO se vuelve a preguntar: se le dio al abrir la cuenta.
        //
        // Preguntarlo otra vez para moverla de sucursal es pedir dos veces lo mismo,
        // y con un desplegable delante alguien acaba dejando el primero de la lista
        // —que es SUPER ADMIN— sin querer. Se hereda el que ya tiene; si algún día
        // hace falta que sea distinto por sucursal, se cambia desde la propia
        // sucursal, que es donde se ve a quién afecta.
        let roleId = datos.roleId;
        if (!roleId) {
            // Primero el rol que se le dio al abrir la cuenta: es el que tiene, y la
            // cuenta se abre sin sucursal, así que es el único sitio donde consta
            // mientras no esté en ninguna. La membresía anterior queda de reserva
            // para las cuentas de antes de que esto se guardara.
            const persona = await prisma.user.findUnique({
                where: { id: datos.userId },
                select: { defaultRoleId: true },
            });
            roleId = persona?.defaultRoleId ?? undefined;
        }
        if (!roleId) {
            const previo = await prisma.memberRole.findFirst({
                where: { member: { userId: datos.userId } },
                orderBy: { member: { createdAt: "desc" } },
                select: { roleId: true },
            });
            if (!previo) {
                return { error: "Esa persona no tiene rol todavía. Dáselo al crearla en Personas." };
            }
            roleId = previo.roleId;
        }

        // Mismo cuidado que al dar de alta: nadie reparte un rol por encima del
        // suyo, o se asciende metiendo a un cómplice.
        const rol = await prisma.role.findUnique({
            where: { id: roleId },
            select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
        });
        if (!rol) return { error: "Ese rol no existe." };
        const veto = await exigirRolRepartible(actor.id, datos.organizationId, [
            { name: rol.name, claves: clavesDe(rol) },
        ]);
        if (veto) return { error: veto };

        const ya = await prisma.member.findFirst({
            where: { organizationId: datos.organizationId, userId: datos.userId },
            select: { id: true },
        });
        if (ya) {
            // Ya está dentro: se le añade el rol y listo, en vez de fallar.
            await prisma.memberRole.upsert({
                where: { memberId_roleId: { memberId: ya.id, roleId } },
                create: { memberId: ya.id, roleId },
                update: {},
            });
            // Sólo se le AÑADE un rol: gana acceso, no se publica nada.
            revalidatePath("/dashboard");
            return { yaEstaba: true, rol: rol.name };
        }

        const miembro = await prisma.member.create({
            data: {
                organizationId: datos.organizationId,
                userId: datos.userId,
                role: "member",
                memberRoles: { create: { roleId } },
            },
            select: { id: true },
        });

        audit({
            action: "member.add",
            resource: miembro.id,
            userId: actor.id,
            meta: { sucursal: datos.organizationId, persona: datos.userId },
        });
        // Alta de membresía: sólo gana acceso, no se publica nada.
        revalidatePath("/dashboard");
        return { rol: rol.name };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * Devolverle a un rol los permisos que trae de fábrica.
 *
 * Hace falta porque el catálogo CRECE. Cuando se añade "exportar informes", los
 * roles que ya existían no lo tienen: la siembra solo pone permisos al crear un
 * rol, precisamente para no devolver en cada despliegue algo que alguien quitó
 * a propósito. Eso deja un hueco, y el hueco se nota como "a mí no me deja".
 *
 * Así que reponerlos es una acción de alguien, no un efecto de arrancar. Se ve
 * lo que va a pasar y se decide.
 */
export async function restablecerPermisosDelRol(roleId: string): Promise<{ error?: string; permisos?: number }> {
    try {
        const actor = await requireAdmin();
        const rol = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
        if (!rol) return { error: "Ese rol no existe." };

        const claves = systemRolePermissionKeys(rol.name);
        if (!claves.length) {
            return { error: `"${rol.name}" no es de los cinco de casa: no tiene permisos de fábrica que reponer.` };
        }

        const permisos = await prisma.permission.findMany({
            where: { key: { in: claves }, isDeprecated: false },
            select: { id: true, key: true },
        });
        // Lo que tenía ANTES: sólo se avisa si el restablecimiento le quita alguna llave.
        const tenia = await prisma.rolePermission.findMany({
            where: { roleId },
            select: { permission: { select: { key: true } } },
        });
        await prisma.$transaction([
            prisma.rolePermission.deleteMany({ where: { roleId } }),
            prisma.rolePermission.createMany({
                data: permisos.map((p) => ({ roleId, permissionId: p.id })),
                skipDuplicates: true,
            }),
        ]);

        audit({
            action: "role.reset",
            resource: roleId,
            userId: actor.id,
            meta: { rol: rol.name, permisos: permisos.length },
        });
        const teniaClaves = tenia.map((t) => t.permission?.key).filter((k): k is string => Boolean(k));
        if (pierdeLlaves(teniaClaves, permisos.map((p) => p.key))) {
            await publicarPermisosCambiados(await personasConRol(roleId), "llaves");
        }
        revalidatePath("/dashboard/permissions");
        return { permisos: permisos.length };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function toggleUserAdmin(userId: string, makeAdmin: boolean): Promise<{ error?: string }> {
    try {
        const admin = await requireAdmin();
        if (admin.id === userId && !makeAdmin) return { error: "No puedes quitarte los permisos de admin" };
        await prisma.user.update({ where: { id: userId }, data: { isSystemAdmin: makeAdmin } });
        audit({ action: "user.admin", resource: userId, userId: admin.id, meta: { ahoraEsSuperAdmin: makeAdmin } });
        // Dar el mando sólo da acceso; quitarlo, lo quita.
        if (!makeAdmin) await publicarPermisosCambiados([userId], "admin");
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function toggleEmailVerified(userId: string, verified: boolean): Promise<{ error?: string }> {
    try {
        await requireAdmin();
        await prisma.user.update({ where: { id: userId }, data: { emailVerified: verified } });
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function adminDeleteUser(userId: string): Promise<{ error?: string }> {
    try {
        const admin = await requireAdmin();
        if (admin.id === userId) return { error: "No puedes eliminar tu propia cuenta" };
        // El correo se lee ANTES de borrar: despues la fila ya no existe y el
        // apunte diria "se elimino la cuenta cmxyz...", que no sirve de nada.
        const victima = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        await prisma.user.delete({ where: { id: userId } });
        audit({ action: "user.delete", resource: userId, userId: admin.id, meta: { correo: victima?.email } });
        await publicarSesionCerrada([userId], "baja");
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}



export async function updateUserProfile(
    userId: string,
    data: { name?: string; phone?: string | null },
): Promise<{ error?: string }> {
    try {
        await requireAdmin();
        if (data.name !== undefined && data.name.trim() === "") return { error: "El nombre no puede estar vacío" };
        const patch: Record<string, unknown> = {};
        for (const k of ["name", "phone"] as const) {
            if (k in data) patch[k] = data[k];
        }
        await prisma.user.update({ where: { id: userId }, data: patch });
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * Ponerle otra contraseña a alguien, desde el panel.
 *
 * Un administrador tiene que poder hacerlo: aquí las cuentas las abre él, muchas
 * con un correo interno que no existe de verdad, así que "que pida el enlace de
 * recuperación" no es una salida — ese correo no llega a ninguna parte. Sin esto,
 * a quien olvida su contraseña hay que borrarlo y volver a crearlo.
 *
 * Se hashea con `hashPassword` de better-auth y se escribe en `account`, que es
 * donde vive: en `user` no hay contraseña. Y se cierran sus sesiones abiertas,
 * porque cambiarle la contraseña a alguien y dejarle la sesión viva no cierra nada.
 */
export async function cambiarContrasena(
    userId: string,
    password: string,
): Promise<{ error?: string; sesionesCerradas?: number }> {
    try {
        const actor = await requireAdmin();
        if (password.length < 8) return { error: "La contraseña necesita 8 caracteres o más." };

        const cuenta = await prisma.account.findFirst({
            where: { userId, providerId: "credential" },
            select: { id: true },
        });
        const hash = await hashPassword(password);

        // Puede no existir: una cuenta creada solo con Google no tiene fila de
        // credenciales. Ponerle contraseña es darle una segunda forma de entrar.
        if (cuenta) {
            await prisma.account.update({ where: { id: cuenta.id }, data: { password: hash } });
        } else {
            await prisma.account.create({
                data: { userId, accountId: userId, providerId: "credential", password: hash },
            });
        }

        // `expiresAt` además de `revokedAt`: sin ella sólo las rutas que miran `revokedAt` la tratarían como cerrada.
        const ahora = new Date();
        const { count } = await prisma.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: ahora, expiresAt: ahora },
        });
        // Y los refresh de la APK y del escritorio: `renovar` no mira las sesiones, y un refresh robado valdría 30 días.
        // Si falla, la clave YA cambió y las sesiones ya están cerradas: se deja dicho y se avisa igualmente (sin datos personales).
        try {
            await cerrarTodasLasFamiliasDe(userId);
        } catch (e) {
            logger.error("[dashboard] no se pudieron cerrar los refresh tras cambiar la contraseña", {
                userId,
                error: e instanceof Error ? e.name : "desconocido",
            });
        }

        audit({
            action: "member.password.reset",
            resource: userId,
            userId: actor.id,
            meta: { sesionesCerradas: count },
        });
        await publicarSesionCerrada([userId], "revocada");
        revalidatePath("/dashboard");
        return { sesionesCerradas: count };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * Cambiarle el rol a alguien.
 *
 * El rol es de la PERSONA: alguien es Supervisora, y lo es en Granma, en Bayamo y en
 * la que la pongan mañana. Por eso se cambia aquí, en su ficha, y no sucursal por
 * sucursal —donde además podían acabar siendo distintos sin que nadie lo notara.
 */
export async function cambiarRol(
    userId: string,
    roleId: string,
): Promise<{ error?: string; rol?: string }> {
    try {
        const actor = await requireAdmin();

        const rol = await prisma.role.findUnique({
            where: { id: roleId },
            select: { id: true, name: true, permissions: { select: { permission: { select: { key: true } } } } },
        });
        if (!rol) return { error: "Ese rol no existe." };

        // Lo que tenía ANTES, para avisar sólo si lo pierde (ver `lib/pierde-acceso.ts`).
        const previo = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                isSystemAdmin: true,
                defaultRole: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
            },
        });

        const mandaEnTodo = esSuperAdmin(rol.name);
        await prisma.user.update({
            where: { id: userId },
            data: {
                defaultRoleId: rol.id,
                // El mando va con el rol en los dos sentidos: dárselo lo asciende y
                // quitárselo lo baja. Si solo subiera, un Super Admin degradado
                // seguiría pudiendo con todo y el cambio no serviría de nada.
                isSystemAdmin: mandaEnTodo,
            },
        });

        audit({ action: "member.role.change", resource: userId, userId: actor.id, meta: { rol: rol.name } });
        const pierde =
            Boolean(previo?.isSystemAdmin && !mandaEnTodo) ||
            pierdeLlaves(previo?.defaultRole ? clavesDe(previo.defaultRole) : [], clavesDe(rol));
        if (pierde) await publicarPermisosCambiados([userId], "rol");
        revalidatePath("/dashboard");
        return { rol: rol.name };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function listUserSessions(
    userId: string,
): Promise<{ error?: string; sessions?: { id: string; ipAddress: string | null; userAgent: string | null; clientId: string | null; createdAt: string; expiresAt: string; revokedAt: string | null }[] }> {
    try {
        await requireAdmin();
        const rows = await prisma.session.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            select: { id: true, ipAddress: true, userAgent: true, clientId: true, createdAt: true, expiresAt: true, revokedAt: true },
        });
        return {
            sessions: rows.map((s) => ({
                id: s.id, ipAddress: s.ipAddress, userAgent: s.userAgent, clientId: s.clientId,
                createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString(),
                revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
            })),
        };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function revokeUserSession(sessionId: string): Promise<{ error?: string }> {
    try {
        const admin = await requireAdmin();
        const ahora = new Date();
        const sesion = await prisma.session.update({
            where: { id: sessionId },
            data: { revokedAt: ahora, expiresAt: ahora }, // expiresAt: ver `cambiarContrasena`
            select: { userId: true },
        });

        const redis = getRedis("sessions");
        await redis.set(`session:revoked:${sessionId}`, "1", "EX", 60 * 60 * 24);
        await publicarSesionCerrada([sesion.userId], "revocada");

        audit({
            action: "session.revoke",
            userId: admin.id,
            meta: { sessionId, count: 1, via: "admin_dashboard" },
        });

        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function revokeAllUserSessions(userId: string): Promise<{ error?: string }> {
    try {
        const admin = await requireAdmin();
        const ahora = new Date();
        const r = await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: ahora, expiresAt: ahora } }); // expiresAt: ver `cambiarContrasena`

        const ids = (await prisma.session.findMany({ where: { userId }, select: { id: true } })).map((s) => s.id);
        if (ids.length) {
            const redis = getRedis("sessions");
            const pipe = redis.pipeline();
            for (const id of ids) pipe.set(`session:revoked:${id}`, "1", "EX", 60 * 60 * 24);
            await pipe.exec();
        }
        await publicarSesionCerrada([userId], "revocada");

        audit({
            action: "session.revoke",
            userId: admin.id,
            meta: { targetUserId: userId, count: r.count, via: "admin_dashboard" },
        });

        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function removeOrgMember(memberId: string): Promise<{ error?: string }> {
    try {
        // Se lee el miembro ANTES de comprobar el permiso: hace falta saber de
        // que sucursal es para poder comprobar si quien pide manda en ella.
        const previo = await prisma.member.findUnique({
            where: { id: memberId },
            select: { organizationId: true },
        });
        if (!previo) return { error: "Miembro no encontrado" };
        const actor = await exigirEnSucursal(previo.organizationId, "member.remove");

        const member = await prisma.member.findUnique({
            where: { id: memberId },
            include: { user: { select: { email: true } }, organization: { select: { name: true } } },
        });
        if (!member) return { error: "Miembro no encontrado" };

        // No dejar una sucursal sin nadie que pueda administrarla: si se va el
        // ultimo Administrador, ya nadie de dentro puede dar de alta a nadie y
        // hay que venir a rescatarla desde fuera.
        if (member.role === "ADMINISTRADOR") {
            const cuantos = await prisma.member.count({
                where: { organizationId: member.organizationId, role: "ADMINISTRADOR" },
            });
            if (cuantos <= 1) {
                return { error: `${member.organization.name} se quedaria sin ningun Administrador. Nombra otro antes de quitar a este.` };
            }
        }

        await prisma.member.delete({ where: { id: memberId } });
        await publicarPermisosCambiados([member.userId], "membresia");
        audit({
            action: "member.remove",
            resource: memberId,
            userId: actor.id,
            meta: { correo: member.user.email, sucursal: member.organization.name },
        });
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function setOrgMemberRoles(memberId: string, roleIds: string[]): Promise<{ error?: string }> {
    try {
        const member = await prisma.member.findUnique({ where: { id: memberId } });
        if (!member) return { error: "Miembro no encontrado" };
        const actor = await exigirEnSucursal(member.organizationId, "member.assignRole");

        // El catálogo de roles es de toda Procovar: basta con que el rol exista.
        // Lo que ata a la persona a su sucursal es el miembro, no el rol.
        const valid = await prisma.role.findMany({
            where: { id: { in: roleIds } },
            select: { id: true, name: true, permissions: { select: { permission: { select: { key: true } } } } },
        });
        if (valid.length !== roleIds.length) return { error: "Rol inválido" };

        const existing = await prisma.memberRole.findMany({ where: { memberId }, select: { roleId: true } });
        const have = new Set(existing.map((r) => r.roleId));
        const want = new Set(roleIds);
        const toAdd = roleIds.filter((id) => !have.has(id));
        const toRemove = existing.filter((r) => !want.has(r.roleId)).map((r) => r.roleId);

        // Nadie reparte un rol por encima del suyo. Sin esto, un Administrador se
        // asciende dandole Super Admin a una cuenta suya — o se clona dandole
        // ADMINISTRADOR, que es lo mismo con otro nombre.
        //
        // Se miran los que se AÑADEN, no los que la persona ya tenía: repartir es
        // dar algo nuevo. Comprobando la lista entera, tocarle un rol cualquiera a
        // quien ya llevaba uno alto fallaba entero —y quien lo intentara no sabría
        // por qué, porque lo que estaba cambiando sí podía dárselo.
        const anadidos = valid.filter((r) => toAdd.includes(r.id));
        const veto = await exigirRolRepartible(
            actor.id,
            member.organizationId,
            anadidos.map((r) => ({ name: r.name, claves: clavesDe(r) })),
        );
        if (veto) return { error: veto };
        await prisma.$transaction([
            ...toAdd.map((roleId) => prisma.memberRole.create({ data: { memberId, roleId } })),
            ...(toRemove.length ? [prisma.memberRole.deleteMany({ where: { memberId, roleId: { in: toRemove } } })] : []),
        ]);
        audit({
            action: "member.roles",
            resource: memberId,
            userId: actor.id,
            meta: { roles: roleIds.length },
        });
        // Sólo si se le QUITA algún rol; añadir roles sólo da acceso.
        if (toRemove.length) await publicarPermisosCambiados([member.userId], "rol");
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * Crear una sucursal.
 *
 * Faltaba: el panel dejaba editar y borrar sucursales, pero no crearlas, así que
 * la única forma de abrir una era tocar la base a mano. Con ocho sucursales y las
 * que vengan, eso no es una excepción rara.
 *
 * Quien la crea entra dentro como ADMINISTRADOR. Una sucursal sin nadie no se
 * puede ni mirar desde el panel —las pantallas piden permisos EN la sucursal— y
 * quedaría inservible hasta que un Super Admin se metiera a arreglarla.
 *
 * El slug sale del nombre, y si choca se le añade un número: "Camagüey" y
 * "camaguey" son la misma URL, y fallar con "ese slug ya está en uso" ante algo
 * que quien crea la sucursal ni ha escrito es hacerle adivinar.
 */
/**
 * Abrir una sucursal, con lo que hace falta para que sirva desde el primer día.
 *
 * Antes sólo pedía el nombre, y una sucursal recién creada nacía sin código, sin teléfono
 * y sin coordenadas. El CÓDIGO es lo peor de los tres: es la clave con la que PEDIDO,
 * delivery y Rutas se refieren a ella, así que sin él la sucursal existe en Accesos y no
 * la conoce nadie más. Y sin coordenadas delivery no puede medir un domicilio.
 *
 * Todo menos el nombre es opcional y se puede completar después en «Editar» — pero se
 * pide aquí, que es cuando la persona tiene los datos delante.
 */
export async function crearSucursal(
    datos: {
        nombre: string;
        codigo?: string;
        telefono?: string;
        direccion?: string;
        latitud?: number | null;
        longitud?: number | null;
    },
): Promise<{ error?: string; orgId?: string }> {
    try {
        const actor = await requireAdmin();

        const nombre = datos.nombre.trim();
        if (!nombre) return { error: "La sucursal necesita un nombre." };

        // El código, en mayúsculas y único: es la clave que cruza las cuatro
        // aplicaciones, y "cam" y "CAM" tienen que ser la misma sucursal.
        const codigo = datos.codigo?.trim().toUpperCase() || null;

        if (codigo) {
            const repetido = await prisma.organization.findUnique({
                where: { codigo },
                select: { name: true },
            });

            if (repetido) return { error: `El código ${codigo} ya es de ${repetido.name}.` };
        }

        const base =
            nombre
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "sucursal";

        const rolAdmin = await prisma.role.findFirst({
            where: { name: "ADMINISTRADOR" },
            select: { id: true },
        });

        for (let intento = 0; intento < 20; intento += 1) {
            const slug = intento === 0 ? base : `${base}-${intento}`;
            try {
                const org = await prisma.$transaction(async (tx) => {
                    const creada = await tx.organization.create({
                        data: {
                            name: nombre,
                            slug,
                            codigo,
                            telefono: datos.telefono?.trim() || null,
                            direccion: datos.direccion?.trim() || null,
                            latitud: datos.latitud ?? null,
                            longitud: datos.longitud ?? null,
                        },
                        select: { id: true },
                    });
                    const miembro = await tx.member.create({
                        data: { organizationId: creada.id, userId: actor.id, role: "admin" },
                        select: { id: true },
                    });
                    if (rolAdmin) {
                        await tx.memberRole.create({
                            data: { memberId: miembro.id, roleId: rolAdmin.id },
                        });
                    }
                    return creada;
                });

                audit({
                    action: "organization.create",
                    resource: org.id,
                    userId: actor.id,
                    meta: { nombre, slug },
                });
                revalidatePath("/dashboard");
                return { orgId: org.id };
            } catch (err) {
                // Slug ocupado: se prueba con el siguiente número.
                if ((err as { code?: string }).code === "P2002") continue;
                throw err;
            }
        }
        return { error: "No se pudo generar una dirección libre para esa sucursal." };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function updateOrganizationAdmin(
    orgId: string,
    data: {
        name?: string; slug?: string; logo?: string | null;
        codigo?: string | null; activa?: boolean; timezone?: string;
        telefono?: string | null; direccion?: string | null;
        latitud?: number | null; longitud?: number | null;
        /**
         * Los almacenes de la sucursal, la lista COMPLETA.
         *
         * Se manda entera y se reemplaza, no se van mandando altas y bajas sueltas: con
         * cuatro o cinco almacenes editados a la vez en un formulario, llevar la cuenta
         * de cuál se borró es donde se cuela el fallo. Aquí lo que llega es lo que queda.
         */
        almacenes?: {
            id?: string;
            nombre: string;
            direccion?: string | null;
            latitud?: number | null;
            longitud?: number | null;
            principal?: boolean;
            activo?: boolean;
        }[];
    },
): Promise<{ error?: string }> {
    try {
        await requireAdmin();
        if (data.name !== undefined && data.name.trim() === "") return { error: "El nombre no puede estar vacío" };
        if (data.slug !== undefined && data.slug.trim() === "") return { error: "El slug no puede estar vacío" };

        // Las coordenadas o van las dos o no va ninguna: una sola no ubica nada, y
        // guardada a medias hace que un cálculo de domicilio salga con un punto
        // inventado en vez de fallar y avisar.
        const par = (a?: number | null, b?: number | null, que = "las coordenadas") =>
            (a == null) !== (b == null) ? `Faltan ${que}: hacen falta latitud y longitud` : null;
        const e1 = par(data.latitud, data.longitud, "las coordenadas de la sucursal");
        if (e1) return { error: e1 };
        for (const a of data.almacenes ?? []) {
            if (!a.nombre?.trim()) return { error: "Cada almacén necesita un nombre" };
            const e = par(a.latitud, a.longitud, `las coordenadas del almacén "${a.nombre}"`);

            if (e) return { error: e };
        }

        // Cuba entera cae en este rectángulo. No es validar por validar: un dígito de
        // más en una latitud pone el almacén en otro continente y el domicilio se
        // cobra por miles de kilómetros.
        const fuera = (lat?: number | null, lng?: number | null) =>
            lat != null && lng != null && (lat < 19 || lat > 24 || lng < -85 || lng > -73);
        if (fuera(data.latitud, data.longitud)) return { error: "Esas coordenadas no caen en Cuba" };
        for (const a of data.almacenes ?? []) {
            if (fuera(a.latitud, a.longitud)) {
                return { error: `Las coordenadas del almacén "${a.nombre}" no caen en Cuba` };
            }
        }

        // Un solo principal. Con dos, cada aplicación elegiría uno distinto para medir la
        // distancia y el mismo domicilio saldría a dos precios según quién pregunte.
        const principales = (data.almacenes ?? []).filter((a) => a.principal).length;

        if (principales > 1) return { error: "Sólo puede haber un almacén principal" };
        if ((data.almacenes?.length ?? 0) > 0 && principales === 0) {
            return { error: "Marca cuál es el almacén principal" };
        }

        // Cómo estaba ANTES: «Editar sucursal» manda siempre `codigo` y `activa`, así que la presencia
        // del campo no dice nada; sólo se avisa si de verdad se desactiva o cambia el código.
        const antes = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { activa: true, codigo: true },
        });

        const patch: Record<string, unknown> = {};
        for (const k of [
            "name", "slug", "logo", "codigo", "activa", "timezone", "telefono",
            "direccion", "latitud", "longitud",
        ] as const) if (k in data) patch[k] = data[k];
        if (typeof patch.codigo === "string") patch.codigo = patch.codigo.trim().toUpperCase() || null;
        try {
            await prisma.$transaction(async (tx) => {
                await tx.organization.update({ where: { id: orgId }, data: patch });

                if (!data.almacenes) return;

                // Se reemplaza la lista entera, dentro de la MISMA transacción: si el
                // alta de uno falla a mitad, no se queda la sucursal sin los que tenía.
                const quedan = data.almacenes.filter((a) => a.id).map((a) => a.id as string);

                await tx.almacen.deleteMany({
                    where: { orgId, ...(quedan.length ? { id: { notIn: quedan } } : {}) },
                });

                for (const a of data.almacenes) {
                    const campos = {
                        nombre: a.nombre.trim(),
                        direccion: a.direccion?.trim() || null,
                        latitud: a.latitud ?? null,
                        longitud: a.longitud ?? null,
                        principal: !!a.principal,
                        activo: a.activo !== false,
                    };

                    if (a.id) await tx.almacen.update({ where: { id: a.id }, data: campos });
                    else await tx.almacen.create({ data: { ...campos, orgId } });
                }
            });
        } catch (err) {
            if ((err as { code?: string }).code === "P2002") {
                // El único otro único es el código, y decir "slug" cuando el choque es
                // de código manda a corregir el campo equivocado.
                const campo = String((err as { meta?: { target?: string[] } }).meta?.target ?? "");
                return { error: campo.includes("codigo") ? "Ese código ya lo usa otra sucursal" : "Ese slug ya está en uso" };
            }
            throw err;
        }
        // `activa` y `codigo` deciden las sucursales que lleva el acceso de cada persona
        // (`resolverIdentidad`); el resto de campos no cambia lo que una aplicación sabe de ellas.
        if (
            antes &&
            sucursalPierdeAcceso(antes, {
                activa: typeof patch.activa === "boolean" ? patch.activa : antes.activa,
                codigo: patch.codigo === undefined ? antes.codigo : (patch.codigo as string | null),
            })
        ) {
            await publicarPermisosCambiados(await personasDeLaSucursal(orgId), "membresia");
        }
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}

export async function deleteOrganizationAdmin(orgId: string): Promise<{ error?: string }> {
    try {
        await requireAdmin();
        // Sus miembros se borran en cascada con ella: hay que apuntarlos ANTES.
        const personas = await personasDeLaSucursal(orgId, { lanzar: true }); // si falla, que no se borre sin avisar
        await prisma.organization.delete({ where: { id: orgId } });
        await publicarPermisosCambiados(personas, "membresia");
        revalidatePath("/dashboard");
        return {};
    } catch (e) {
        return { error: (e as Error).message };
    }
}
