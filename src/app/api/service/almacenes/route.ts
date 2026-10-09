/**
 * Los ALMACENES de una sucursal. Service-auth.
 *
 * # Por qué se leen y se escriben desde fuera
 *
 * El dato vive aquí porque el almacén es de la sucursal, y la sucursal es de Accesos.
 * Pero quien lo usa y quien sabe si es correcto es DELIVERY: el domicilio se cobra por la
 * distancia desde el almacén, así que un punto mal puesto se cobra mal en cada entrega, y
 * quien lo nota es el que reparte — no quien administra cuentas.
 *
 * Tenerlo editable en los dos sitios era invitar a que se cambiara en el que nadie mira.
 *
 * GET  ?codigo=CAM     los de esa sucursal (sin código, los de todas).
 * PUT  { codigo, almacenes: [...] }   la lista COMPLETA de esa sucursal.
 *
 * El PUT manda la lista entera y no un almacén suelto a propósito: se editan tres o
 * cuatro a la vez en un formulario, y llevar la cuenta de cuál se creó, cuál se cambió y
 * cuál se borró es trabajo que el navegador no tiene por qué hacer. Se manda cómo tiene
 * que quedar y aquí se resuelve.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const AlmacenSchema = z.object({
    /** Vacío = es nuevo. */
    id: z.string().optional(),
    nombre: z.string().min(1),
    /**
     * El `objectCode` de Ventra. AUSENTE = no tocar el que ya tiene (los clientes viejos de Reparto no
     * lo mandan y no pueden borrar los códigos al guardar); "" o null = quitarlo.
     */
    codigo: z.string().max(40).nullish(),
    direccion: z.string().nullish(),
    latitud: z.number().nullish(),
    longitud: z.number().nullish(),
    principal: z.boolean().optional(),
    activo: z.boolean().optional(),
});

const BodySchema = z.object({
    codigo: z.string().min(1),
    almacenes: z.array(AlmacenSchema).max(50),
});

const salida = (a: {
    id: string;
    nombre: string;
    codigo: string | null;
    direccion: string | null;
    latitud: number | null;
    longitud: number | null;
    principal: boolean;
    activo: boolean;
}) => a;

export const GET = withServiceAuth(async (req: NextRequest) => {
    const codigo = new URL(req.url).searchParams.get('codigo')?.trim().toUpperCase();

    const orgs = await prisma.organization.findMany({
        where: codigo ? { codigo } : { codigo: { not: null } },
        select: {
            codigo: true,
            name: true,
            almacenes: {
                select: {
                    id: true, nombre: true, codigo: true, direccion: true,
                    latitud: true, longitud: true, principal: true, activo: true,
                },
                orderBy: [{ principal: 'desc' }, { nombre: 'asc' }],
            },
        },
        orderBy: { name: 'asc' },
    });

    return NextResponse.json({
        sucursales: orgs.map((o) => ({
            codigo: o.codigo,
            nombre: o.name,
            almacenes: o.almacenes.map(salida),
        })),
    });
});

export const PUT = withServiceAuth(async (req: NextRequest) => {
    const cuerpo = BodySchema.safeParse(await req.json().catch(() => null));

    if (!cuerpo.success) {
        return NextResponse.json({ error: 'cuerpo_invalido', detalle: cuerpo.error.issues }, { status: 400 });
    }

    const { codigo, almacenes } = cuerpo.data;
    const org = await prisma.organization.findUnique({
        where: { codigo: codigo.trim().toUpperCase() },
        select: { id: true },
    });

    if (!org) return NextResponse.json({ error: `no hay sucursal con código ${codigo}` }, { status: 404 });

    /**
     * UNO principal, y sólo uno.
     *
     * Es desde el que se mide cuando nadie dice cuál. Con dos marcados, cada aplicación
     * elegiría uno distinto y el mismo domicilio saldría por dos distancias; con ninguno,
     * ninguna sabría desde dónde medir. Si no viene marcado ninguno, se marca el primero.
     */
    // Dos almacenes de la misma sucursal con el mismo código no se pueden emparejar con un pedido: se
    // rechaza aquí con el nombre de los dos, y no con el error crudo del índice único.
    const vistos = new Map<string, string>();
    for (const a of almacenes) {
        const c = a.codigo?.trim().toUpperCase();
        if (!c) continue;
        const otro = vistos.get(c);
        if (otro) {
            return NextResponse.json(
                { error: `el código ${c} lo llevan dos almacenes: «${otro}» y «${a.nombre.trim()}»` },
                { status: 409 },
            );
        }
        vistos.set(c, a.nombre.trim());
    }

    const marcados = almacenes.filter((a) => a.principal);
    const principal = marcados[0] ?? almacenes[0];

    try {
        await prisma.$transaction(async (tx) => {
            // Los que ya no vienen, fuera. La lista que llega es cómo tiene que quedar.
            const quedan = almacenes.map((a) => a.id).filter(Boolean) as string[];

            await tx.almacen.deleteMany({
                where: { orgId: org.id, ...(quedan.length ? { id: { notIn: quedan } } : {}) },
            });

            // Intercambiar códigos entre dos almacenes (A: 2→13, B: 13→2) chocaría con el índice único a mitad
            // del bucle. Los que traen código se liberan primero y el bucle los deja como vienen.
            const aRecodificar = almacenes.filter((a) => a.id && a.codigo !== undefined).map((a) => a.id as string);
            if (aRecodificar.length) {
                await tx.almacen.updateMany({ where: { orgId: org.id, id: { in: aRecodificar } }, data: { codigo: null } });
            }

            for (const a of almacenes) {
                const datos = {
                    nombre: a.nombre.trim(),
                    direccion: a.direccion?.trim() || null,
                    // Vacío es «no lo sé», no cero: un cero pone el almacén en el Atlántico y
                    // el domicilio se cobra por miles de kilómetros.
                    latitud: a.latitud ?? null,
                    longitud: a.longitud ?? null,
                    principal: a === principal,
                    activo: a.activo ?? true,
                    // undefined = Prisma no lo toca. Los códigos de Ventra son números y letras que se
                    // comparan sin mayúsculas en Reparto: se guardan ya en mayúsculas y sin espacios.
                    ...(a.codigo !== undefined && { codigo: a.codigo?.trim().toUpperCase() || null }),
                };

                if (a.id) await tx.almacen.update({ where: { id: a.id }, data: datos });
                else await tx.almacen.create({ data: { ...datos, orgId: org.id } });
            }
        });
    } catch (e) {
        // Dos peticiones a la vez con el mismo código: gana una y la otra recibe esto, no un 500.
        if ((e as { code?: string })?.code === 'P2002') {
            return NextResponse.json({ error: 'ese código ya lo lleva otro almacén de la sucursal' }, { status: 409 });
        }
        throw e;
    }

    const guardados = await prisma.almacen.findMany({
        where: { orgId: org.id },
        select: {
            id: true, nombre: true, codigo: true, direccion: true,
            latitud: true, longitud: true, principal: true, activo: true,
        },
        orderBy: [{ principal: 'desc' }, { nombre: 'asc' }],
    });

    return NextResponse.json({ codigo, almacenes: guardados.map(salida) });
});
