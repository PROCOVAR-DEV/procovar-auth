import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { publicarPermisosCambiados } from '@/lib/eventos-de-sesion';
import { cambioDeRolPuedeQuitar } from '@/lib/pierde-acceso';

type Params = { params: Promise<{ orgId: string; memberId: string }> };

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
 * PATCH /api/organizations/[orgId]/members/[memberId]
 * Update member role (admin/owner only)
 */
export async function PATCH(request: Request, { params }: Params) {
    try {
        const { orgId, memberId } = await params;
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const currentMembership = await getMembership(session.user.id, orgId);
        
        if (!currentMembership || !['owner', 'admin'].includes(currentMembership.role)) {
            return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        }

        const targetMember = await prisma.member.findUnique({
            where: { id: memberId },
        });

        if (!targetMember || targetMember.organizationId !== orgId) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        // Cannot modify owner unless you're an owner
        if (targetMember.role === 'owner' && currentMembership.role !== 'owner') {
            return NextResponse.json({ error: 'Cannot modify owner' }, { status: 403 });
        }

        // Cannot modify yourself
        if (targetMember.userId === session.user.id) {
            return NextResponse.json({ error: 'Cannot modify your own membership' }, { status: 400 });
        }

        const body = await request.json();
        const { role } = body;

        // Validate role — must be one of the valid assignable roles or 'owner' for transfer
        const validRoles = ['admin', 'staff', 'agent'];

        if (role === 'owner') {
            // Only owners can transfer ownership
            if (currentMembership.role !== 'owner') {
                return NextResponse.json({ error: 'Only owners can transfer ownership' }, { status: 403 });
            }
            
            // Transfer ownership: demote current owner to admin
            await prisma.$transaction([
                prisma.member.update({
                    where: { id: currentMembership.id },
                    data: { role: 'admin' },
                }),
                prisma.member.update({
                    where: { id: memberId },
                    data: { role: 'owner' },
                }),
            ]);
            // Quien recibe la propiedad sólo gana; quien la entrega baja a admin: sólo él pierde.
            await publicarPermisosCambiados([currentMembership.userId], 'rol');

            return NextResponse.json({ 
                message: 'Ownership transferred',
                newRole: 'owner',
            });
        }

        if (!validRoles.includes(role)) {
            return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
        }

        // Admin cannot promote to admin — only owners can
        if (currentMembership.role === 'admin' && role === 'admin') {
            return NextResponse.json({ error: 'Only owners can promote to admin' }, { status: 403 });
        }

        const member = await prisma.member.update({
            where: { id: memberId },
            data: { role },
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

        // Sólo si el cambio puede QUITAR algo (bajar de rango); ascender sólo da acceso.
        if (cambioDeRolPuedeQuitar(targetMember.role, role)) await publicarPermisosCambiados([member.userId], 'rol');
        return NextResponse.json({ member });
    } catch (error) {
        console.error('Failed to update member:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * DELETE /api/organizations/[orgId]/members/[memberId]
 * Remove member from organization (admin/owner only, or self-leave)
 */
export async function DELETE(request: Request, { params }: Params) {
    try {
        const { orgId, memberId } = await params;
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const currentMembership = await getMembership(session.user.id, orgId);
        
        if (!currentMembership) {
            return NextResponse.json({ error: 'Not a member of this organization' }, { status: 403 });
        }

        const targetMember = await prisma.member.findUnique({
            where: { id: memberId },
        });

        if (!targetMember || targetMember.organizationId !== orgId) {
            return NextResponse.json({ error: 'Member not found' }, { status: 404 });
        }

        // Check if user is removing themselves (leaving)
        const isSelfLeave = targetMember.userId === session.user.id;

        if (isSelfLeave) {
            // Owners cannot leave, they must transfer ownership first
            if (targetMember.role === 'owner') {
                return NextResponse.json(
                    { error: 'Owners must transfer ownership before leaving' },
                    { status: 400 }
                );
            }
        } else {
            // Removing someone else requires admin/owner permissions
            if (!['owner', 'admin'].includes(currentMembership.role)) {
                return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
            }

            // Cannot remove owner
            if (targetMember.role === 'owner') {
                return NextResponse.json({ error: 'Cannot remove owner' }, { status: 403 });
            }

            // Admins cannot remove other admins — only owner can
            if (currentMembership.role === 'admin' && targetMember.role === 'admin') {
                return NextResponse.json({ error: 'Admins cannot remove other admins' }, { status: 403 });
            }
        }

        await prisma.member.delete({
            where: { id: memberId },
        });
        await publicarPermisosCambiados([targetMember.userId], 'membresia');

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to remove member:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
