import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';

type Params = { params: Promise<{ orgId: string }> };

/**
 * Helper to check membership and role
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
 * GET /api/organizations/[orgId]/members
 * Get all members of an organization
 */
export async function GET(request: Request, { params }: Params) {
    try {
        const { orgId } = await params;
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const membership = await getMembership(session.user.id, orgId);
        
        if (!membership) {
            return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 });
        }

        const members = await prisma.member.findMany({
            where: { organizationId: orgId },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                        createdAt: true,
                    },
                },
            },
            orderBy: [
                { role: 'asc' }, // owners first, then admins, then members
                { createdAt: 'asc' },
            ],
        });

        return NextResponse.json({ members });
    } catch (error) {
        console.error('Failed to fetch members:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * POST /api/organizations/[orgId]/members
 * Add a member directly (admin/owner only) - for existing users
 */
export async function POST(request: Request, { params }: Params) {
    try {
        const { orgId } = await params;
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const membership = await getMembership(session.user.id, orgId);
        
        if (!membership || !['owner', 'admin'].includes(membership.role)) {
            return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        }

        const body = await request.json();
        const { userId, email, role = 'agent' } = body;

        // Validate role — owner is only assigned at creation, never via API
        const validRoles = ['admin', 'staff', 'agent'];
        if (!validRoles.includes(role)) {
            return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
        }
        // Only owners can add admins
        if (role === 'admin' && membership.role !== 'owner') {
            return NextResponse.json({ error: 'Only owners can add admins' }, { status: 403 });
        }

        // Find user by userId or email
        let targetUser;
        if (userId) {
            targetUser = await prisma.user.findUnique({ where: { id: userId } });
        } else if (email) {
            targetUser = await prisma.user.findUnique({ where: { email } });
        }

        if (!targetUser) {
            return NextResponse.json(
                { error: 'User not found. Use invitations for new users.' },
                { status: 404 }
            );
        }

        // Check if already a member
        const existingMember = await prisma.member.findUnique({
            where: {
                userId_organizationId: {
                    userId: targetUser.id,
                    organizationId: orgId,
                },
            },
        });

        if (existingMember) {
            return NextResponse.json({ error: 'User is already a member' }, { status: 409 });
        }

        const member = await prisma.member.create({
            data: {
                userId: targetUser.id,
                organizationId: orgId,
                role,
            },
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
        });

        // Un alta sólo da acceso: no se publica nada. Publicar aquí dejaba a cualquier dueño de una
        // organización echar de todas las aplicaciones a quien añadiera por correo (auditoría 08/10/2026).
        return NextResponse.json({ member }, { status: 201 });
    } catch (error) {
        console.error('Failed to add member:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
