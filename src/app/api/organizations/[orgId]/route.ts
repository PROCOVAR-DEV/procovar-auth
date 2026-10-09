import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { personasDeLaSucursal, publicarPermisosCambiados } from '@/lib/eventos-de-sesion';
import { sucursalPierdeAcceso } from '@/lib/pierde-acceso';

type Params = { params: Promise<{ orgId: string }> };

/**
 * Helper: extract Bearer token from Authorization header
 */
function getBearerToken(request: Request): string | null {
    const authHeader = request.headers.get('authorization') || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
}

/**
 * Helper: check if request has a valid service Bearer token
 */
function isServiceAuth(request: Request): boolean {
    const token = getBearerToken(request);
    const expected = (process.env.BEARER_TOKEN) || '';
    return !!token && !!expected && token === expected;
}

/**
 * Helper to check if user is a member of the organization
 */
async function getMembership(userId: string, orgId: string) {
    return prisma.member.findUnique({
        where: {
            userId_organizationId: {
                userId,
                organizationId: orgId,
            },
        },
    });
}

/**
 * @swagger
 * /api/organizations/{orgId}:
 *   get:
 *     summary: Get organization details
 *     description: Get detailed information about an organization. Requires membership.
 *     tags:
 *       - Organizations
 *     security:
 *       - CookieAuth: []
 *     parameters:
 *       - in: path
 *         name: orgId
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
 *     responses:
 *       200:
 *         description: Organization details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 organization:
 *                   $ref: '#/components/schemas/Organization'
 *                 currentUserRole:
 *                   type: string
 *                   enum: [owner, admin, member]
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a member of this organization
 *       404:
 *         description: Organization not found
 *       500:
 *         description: Internal server error
 */
export async function GET(request: Request, { params }: Params) {
    try {
        const { orgId } = await params;

        // Support both session auth and service Bearer token
        if (isServiceAuth(request)) {
            const organization = await prisma.organization.findUnique({
                where: { id: orgId },
                include: {
                    members: {
                        include: {
                            user: {
                                select: {
                                    id: true,
                                    name: true,
                                    email: true,
                                    image: true,
                                },
                            },
                        },
                    },
                    _count: {
                        select: {
                            members: true,
                            invitations: true,
                        },
                    },
                },
            });

            if (!organization) {
                return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
            }

            // For service auth, return owner as the role
            const ownerMember = organization.members.find((m) => m.role === 'owner');
            return NextResponse.json({
                organization,
                currentUserRole: ownerMember ? 'owner' : 'admin',
            });
        }

        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const membership = await getMembership(session.user.id, orgId);
        
        if (!membership) {
            return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 });
        }

        const organization = await prisma.organization.findUnique({
            where: { id: orgId },
            include: {
                members: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                            },
                        },
                    },
                },
                _count: {
                    select: {
                        members: true,
                        invitations: true,
                    },
                },
            },
        });

        if (!organization) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        return NextResponse.json({ 
            organization,
            currentUserRole: membership.role,
        });
    } catch (error) {
        console.error('Failed to fetch organization:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * @swagger
 * /api/organizations/{orgId}:
 *   patch:
 *     summary: Update organization
 *     description: Update organization details. Requires admin or owner role.
 *     tags:
 *       - Organizations
 *     security:
 *       - CookieAuth: []
 *     parameters:
 *       - in: path
 *         name: orgId
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               logo:
 *                 type: string
 *                 nullable: true
 *               metadata:
 *                 type: object
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Organization updated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       409:
 *         description: Slug already exists
 *       500:
 *         description: Internal server error
 */
export async function PATCH(request: Request, { params }: Params) {
    try {
        const { orgId } = await params;

        // Support both session auth and service Bearer token
        if (!isServiceAuth(request)) {
            const session = await auth.api.getSession({ headers: await headers() });
            
            if (!session?.user) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const membership = await getMembership(session.user.id, orgId);
            
            if (!membership || !['owner', 'admin'].includes(membership.role)) {
                return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
            }
        }

        const body = await request.json();
        const { name, slug, logo, metadata } = body;
        // Los datos de la sucursal como HECHO: dónde está, cómo la llaman los demás
        // sistemas, y dónde está su almacén.
        const {
            codigo, activa, timezone, telefono, direccion, latitud, longitud,
        } = body;

        // Un número que llega vacío desde un formulario es "" y `Number("")` es 0 —
        // que en una coordenada es un punto en el golfo de Guinea, no "sin dato".
        const num = (v: unknown) =>
            v === '' || v === null || v === undefined ? null : Number(v);
        const txt = (v: unknown) =>
            typeof v === 'string' ? (v.trim() || null) : v === null ? null : undefined;

        // El código identifica la sucursal en TODOS los sistemas: dos iguales harían
        // que un pedido de Camagüey se contara en Santiago.
        if (codigo) {
            const repetido = await prisma.organization.findFirst({
                where: { codigo: String(codigo).toUpperCase(), NOT: { id: orgId } },
                select: { name: true },
            });
            if (repetido) {
                return NextResponse.json(
                    { error: `El código ${codigo} ya lo usa ${repetido.name}` },
                    { status: 409 },
                );
            }
        }

        // Check if new slug is taken by another org
        if (slug) {
            const existingOrg = await prisma.organization.findFirst({
                where: {
                    slug,
                    NOT: { id: orgId },
                },
            });

            if (existingOrg) {
                return NextResponse.json(
                    { error: 'Organization slug already exists' },
                    { status: 409 }
                );
            }
        }

        // Cómo estaba ANTES, para avisar sólo si de verdad se desactiva o cambia el código.
        const antes = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { activa: true, codigo: true },
        });

        const organization = await prisma.organization.update({
            where: { id: orgId },
            data: {
                ...(name && { name }),
                ...(slug && { slug }),
                ...(logo !== undefined && { logo }),
                ...(metadata !== undefined && { metadata: metadata ? JSON.stringify(metadata) : null }),
                ...(codigo !== undefined && { codigo: codigo ? String(codigo).toUpperCase() : null }),
                ...(activa !== undefined && { activa: Boolean(activa) }),
                ...(timezone !== undefined && txt(timezone) !== undefined && { timezone: txt(timezone) || 'America/Havana' }),
                ...(telefono !== undefined && { telefono: txt(telefono) ?? null }),
                ...(direccion !== undefined && { direccion: txt(direccion) ?? null }),
                ...(latitud !== undefined && { latitud: num(latitud) }),
                ...(longitud !== undefined && { longitud: num(longitud) }),
                // Los almacenes ya no son campos de la sucursal: viven en su propia
                // tabla porque una sucursal puede tener varios. Se editan desde el
                // formulario de Sucursales, que manda la lista entera.
            },
        });

        // `activa` y `codigo` deciden las sucursales que lleva el acceso de cada persona; sólo se avisa
        // si cambian de verdad (un formulario que las manda siempre no puede echar a toda la sucursal).
        if (
            antes &&
            sucursalPierdeAcceso(antes, { activa: organization.activa, codigo: organization.codigo ?? null })
        ) {
            await publicarPermisosCambiados(await personasDeLaSucursal(orgId), 'membresia');
        }
        return NextResponse.json({ organization });
    } catch (error) {
        console.error('Failed to update organization:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * @swagger
 * /api/organizations/{orgId}:
 *   delete:
 *     summary: Delete organization
 *     description: Permanently delete an organization. Requires owner role.
 *     tags:
 *       - Organizations
 *     security:
 *       - CookieAuth: []
 *     parameters:
 *       - in: path
 *         name: orgId
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
 *     responses:
 *       200:
 *         description: Organization deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Only owners can delete organizations
 *       500:
 *         description: Internal server error
 */
export async function DELETE(request: Request, { params }: Params) {
    try {
        const { orgId } = await params;
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const membership = await getMembership(session.user.id, orgId);
        
        if (!membership || membership.role !== 'owner') {
            return NextResponse.json({ error: 'Only owners can delete organizations' }, { status: 403 });
        }

        // Sus miembros se borran en cascada con ella: se apuntan ANTES.
        const personas = await personasDeLaSucursal(orgId, { lanzar: true }); // si falla, que no se borre sin avisar
        await prisma.organization.delete({
            where: { id: orgId },
        });
        await publicarPermisosCambiados(personas, 'membresia');

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete organization:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
