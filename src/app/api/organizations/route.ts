import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';

const MAX_SLUG_ATTEMPTS = 25;

const slugify = (value: string) => {
    const slug = value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);

    return slug.length > 0 ? slug : 'organization';
};

const getBearerToken = (request: NextRequest) => {
    const authHeader = request.headers.get('authorization') || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
};

const getEnvBearerToken = () => (process.env.BEARER_TOKEN) || '';

/**
 * @swagger
 * /api/organizations:
 *   get:
 *     summary: List user organizations
 *     description: Get all organizations where the current user is a member
 *     tags:
 *       - Organizations
 *     security:
 *       - CookieAuth: []
 *     responses:
 *       200:
 *         description: List of organizations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 organizations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       slug:
 *                         type: string
 *                       logo:
 *                         type: string
 *                         nullable: true
 *                       role:
 *                         type: string
 *                         enum: [owner, admin, member]
 *                       membershipId:
 *                         type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
export async function GET() {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const memberships = await prisma.member.findMany({
            where: { userId: session.user.id },
            include: {
                organization: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        const organizations = memberships.map((m) => ({
            ...m.organization,
            role: m.role,
            membershipId: m.id,
        }));

        return NextResponse.json({ organizations });
    } catch (error) {
        console.error('Failed to fetch organizations:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * @swagger
 * /api/organizations:
 *   post:
 *     summary: Create organization
 *     description: Create a new organization. The creator becomes the owner.
 *     tags:
 *       - Organizations
 *     security:
 *       - CookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - slug
 *             properties:
 *               name:
 *                 type: string
 *                 description: Organization display name
 *               slug:
 *                 type: string
 *                 description: URL-friendly unique identifier
 *               logo:
 *                 type: string
 *                 description: Logo URL
 *               metadata:
 *                 type: object
 *                 description: Custom metadata
 *     responses:
 *       201:
 *         description: Organization created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 organization:
 *                   $ref: '#/components/schemas/Organization'
 *       400:
 *         description: Name and slug are required
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: Slug already exists
 *       500:
 *         description: Internal server error
 */
export async function POST(request: NextRequest) {
    try {
        const token = getBearerToken(request);
        if (!token) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const expectedToken = getEnvBearerToken();
        if (!expectedToken || token !== expectedToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
        const logoUrl = typeof body?.logoUrl === 'string' ? body.logoUrl.trim() : null;

        if (!name || !userId) {
            return NextResponse.json({ error: 'Name and userId are required' }, { status: 400 });
        }

        const userExists = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        });

        if (!userExists) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const baseSlug = slugify(name);

        for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
            const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;

            try {
                const organization = await prisma.$transaction(async (tx) => {
                    const createdOrg = await tx.organization.create({
                        data: {
                            name,
                            slug,
                            logo: logoUrl || null,
                        },
                    });

                    await tx.member.create({
                        data: {
                            userId,
                            organizationId: createdOrg.id,
                            role: 'owner',
                        },
                    });

                    return createdOrg;
                });

                // Crear la sucursal con su dueño sólo da acceso: no se publica nada.
                return NextResponse.json({ organization }, { status: 201 });
            } catch (error) {
                if (
                    error instanceof Prisma.PrismaClientKnownRequestError &&
                    error.code === 'P2002'
                ) {
                    continue;
                }

                throw error;
            }
        }

        return NextResponse.json({ error: 'Unable to generate unique slug' }, { status: 500 });
    } catch (error) {
        console.error('Failed to create organization:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
