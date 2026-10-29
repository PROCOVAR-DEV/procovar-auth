/**
 * GET /api/service/sucursales — las sucursales (código, nombre, si operan). Service-auth.
 *
 * Para que las aplicaciones NO lleven su propia lista de sucursales: la sucursal es de Accesos
 * (`Organization.codigo`), y quien necesita elegir una (el cuadre de Transferencias, para quien ve
 * todas) la pide aquí. Una lista copiada se queda atrás en cuanto se abre o se cierra una.
 *
 * Solo lectura. Solo las que tienen código (sin él ningún sistema sabría llamarla).
 * `?activas=0` incluye también las cerradas; por defecto solo las que operan.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { withServiceAuth } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export const GET = withServiceAuth(async (req: NextRequest) => {
    const soloActivas = new URL(req.url).searchParams.get('activas') !== '0';
    const filas = await prisma.organization.findMany({
        where: { codigo: { not: null }, ...(soloActivas ? { activa: true } : {}) },
        select: { codigo: true, name: true, activa: true, timezone: true },
        orderBy: { codigo: 'asc' },
    });
    return NextResponse.json({
        sucursales: filas.map((o) => ({
            codigo: o.codigo,
            nombre: o.name,
            activa: o.activa,
            timezone: o.timezone,
        })),
    });
});
