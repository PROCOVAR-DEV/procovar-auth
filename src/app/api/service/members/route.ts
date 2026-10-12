/**
 * POST /api/service/members
 *
 * La gente de una sucursal, con su rol de Procovar. Service-auth.
 *
 * # Para qué
 *
 * Las otras aplicaciones necesitan poner NOMBRES DE PERSONA en sus desplegables, y
 * hasta ahora no tenían de dónde sacarlos: sólo sabían de alguien cuando esa persona
 * entraba y se verificaba su sesión. Eso obliga a cada aplicación a inventarse sus
 * propios «usuarios» a partir de lo que tenga a mano —el nombre de una carpeta de
 * Drive, el de un fichero— y a acabar con dos listas de personas que no se parecen y
 * que nadie puede casar.
 *
 * El caso concreto: en Rutas, cada carpeta de Drive es el GPS de alguien, y para
 * decir de quién hay que poder elegir a una PERSONA de verdad, no a un apaño hecho
 * con el nombre de la carpeta.
 *
 * Devuelve el rol tal como lo entiende Procovar (SUPERVISOR, GESTOR…), que vive en
 * `member_role`, y no el de la organización (owner/admin/member), que no dice nada
 * sobre lo que esa persona hace.
 *
 * Es de SOLO LECTURA y no expone nada que no sea nombre, correo y rol: ni sesiones,
 * ni permisos, ni nada con lo que se pueda entrar a ningún sitio.
 *
 * Body: { organizationId?: string, roles?: string[], supervisorId?: string, userIds?: string[] }
 *   organizationId  la sucursal. Sin él, todas: lo pide un super admin.
 *   roles           filtra por rol. Sin él, todos.
 *   supervisorId    sólo el EQUIPO de ese supervisor (personas con `supervisorId` = él).
 *   userIds         sólo esas personas (hasta 500): el código y el nombre de un lote.
 *
 * Cada fila lleva además `codigoVendedor` y `supervisorId` (o `null`) y `activo`. Lo pide el CRM, que
 * decide por eso qué ve un supervisor; el token y `verify-session` sólo llevan los de la
 * propia persona, no la lista del equipo, para no inflar cada petición de cada aplicación.
 * Una persona en varias sucursales sale una vez POR SUCURSAL (como siempre): deduplicar por `id`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const BodySchema = z.object({
    organizationId: z.string().min(1).optional(),
    roles: z.array(z.string().min(1)).max(20).optional(),
    supervisorId: z.string().min(1).optional(),
    userIds: z.array(z.string().min(1)).max(500).optional(),
});

export const POST = withServiceAuth(async (req: NextRequest) => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        // Cuerpo vacío = «dame todas». Es una consulta sin argumentos y no tiene
        // sentido exigir un `{}` para hacerla.
        body = {};
    }

    const parsed = BodySchema.safeParse(body ?? {});
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }
    const { organizationId, roles, supervisorId, userIds } = parsed.data;

    try {
        const rows = await prisma.member.findMany({
            where: {
                ...(organizationId ? { organizationId } : {}),
                ...(userIds ? { userId: { in: userIds } } : {}),
                ...(supervisorId ? { user: { supervisorId } } : {}),
            },
            include: {
                user: { select: { id: true, name: true, email: true, activo: true, codigoVendedor: true, supervisorId: true } },
                organization: { select: { id: true, name: true, slug: true } },
                memberRoles: { include: { role: { select: { name: true } } } },
            },
            orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }],
        });

        const members = rows
            .map((m) => ({
                id: m.user.id,
                name: m.user.name,
                email: m.user.email,
                codigoVendedor: m.user.codigoVendedor ?? null,
                supervisorId: m.user.supervisorId ?? null,
                // Las bajas no se borran (sus pedidos cuelgan de ellas): quien lista un equipo, que las filtre.
                activo: m.user.activo,
                organizationId: m.organizationId,
                organizationName: m.organization?.name ?? null,
                organizationSlug: m.organization?.slug ?? null,
                roles: m.memberRoles.map((mr) => mr.role.name),
            }))
            // El filtro por rol se aplica AQUÍ y no en la consulta porque una persona
            // puede llevar varios roles y lo que se pregunta es «¿tiene alguno de
            // estos?», que en SQL sobre la tabla puente sale mucho más enrevesado de
            // lo que merece una lista de decenas de filas.
            .filter((m) => !roles?.length || m.roles.some((r) => roles.includes(r)));

        return NextResponse.json({ count: members.length, members });
    } catch (error) {
        logger.error(`service/members falló: ${String(error)}`);
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
});
