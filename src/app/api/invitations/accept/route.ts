import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import crypto from 'crypto';

/**
 * @swagger
 * /api/invitations/accept:
 *   get:
 *     summary: Preview invitation
 *     description: Get invitation details by token before accepting. Does not require authentication.
 *     tags:
 *       - Invitations
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: Invitation token from the invite URL
 *     responses:
 *       200:
 *         description: Invitation details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invitation:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *                     organization:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                         logo:
 *                           type: string
 *                           nullable: true
 *                     inviter:
 *                       type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                         email:
 *                           type: string
 *                         image:
 *                           type: string
 *                           nullable: true
 *       400:
 *         description: Token required or invitation expired/invalid status
 *       404:
 *         description: Invalid invitation token
 *       500:
 *         description: Internal server error
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const token = searchParams.get('token');

        if (!token) {
            return NextResponse.json({ error: 'Token is required' }, { status: 400 });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const invitation = await prisma.invitation.findFirst({
            where: { tokenHash },
            include: {
                organization: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        logo: true,
                    },
                },
                inviter: {
                    select: {
                        name: true,
                        email: true,
                        image: true,
                    },
                },
            },
        });

        if (!invitation) {
            return NextResponse.json({ error: 'Invalid invitation token' }, { status: 404 });
        }

        if (invitation.status !== 'pending') {
            return NextResponse.json(
                { error: `Invitation has been ${invitation.status}` },
                { status: 400 }
            );
        }

        if (invitation.expiresAt < new Date()) {
            return NextResponse.json({ error: 'Invitation has expired' }, { status: 400 });
        }

        return NextResponse.json({
            invitation: {
                id: invitation.id,
                email: invitation.email,
                role: invitation.role,
                expiresAt: invitation.expiresAt,
                organization: invitation.organization,
                inviter: invitation.inviter,
            },
        });
    } catch (error) {
        console.error('Failed to get invitation:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * @swagger
 * /api/invitations/accept:
 *   post:
 *     summary: Accept invitation
 *     description: Accept an invitation and become a member of the organization. Requires authentication.
 *     tags:
 *       - Invitations
 *     security:
 *       - CookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: Invitation token from the invite URL
 *     responses:
 *       200:
 *         description: Invitation accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 member:
 *                   $ref: '#/components/schemas/Member'
 *       400:
 *         description: Token required or invitation expired
 *       401:
 *         description: Please sign in to accept invitation
 *       403:
 *         description: Invitation sent to different email
 *       404:
 *         description: Invalid invitation token
 *       500:
 *         description: Internal server error
 */
export async function POST(request: Request) {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        
        if (!session?.user) {
            return NextResponse.json({ error: 'Please sign in to accept this invitation' }, { status: 401 });
        }

        const body = await request.json();
        const { token } = body;

        if (!token) {
            return NextResponse.json({ error: 'Token is required' }, { status: 400 });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const invitation = await prisma.invitation.findFirst({
            where: { tokenHash },
            include: {
                organization: true,
            },
        });

        if (!invitation) {
            return NextResponse.json({ error: 'Invalid invitation token' }, { status: 404 });
        }

        if (invitation.status !== 'pending') {
            return NextResponse.json(
                { error: `Invitation has been ${invitation.status}` },
                { status: 400 }
            );
        }

        if (invitation.expiresAt < new Date()) {
            await prisma.invitation.update({
                where: { id: invitation.id },
                data: { status: 'expired' },
            });
            return NextResponse.json({ error: 'Invitation has expired' }, { status: 400 });
        }

        // Check if user email matches invitation email (optional, can be relaxed)
        if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
            return NextResponse.json(
                { error: 'This invitation was sent to a different email address' },
                { status: 403 }
            );
        }

        // Check if already a member
        const existingMember = await prisma.member.findUnique({
            where: {
                userId_organizationId: {
                    userId: session.user.id,
                    organizationId: invitation.organizationId,
                },
            },
        });

        if (existingMember) {
            // Mark invitation as accepted anyway
            await prisma.invitation.update({
                where: { id: invitation.id },
                data: { 
                    status: 'accepted',
                    acceptedAt: new Date(),
                },
            });
            return NextResponse.json({ 
                message: 'You are already a member of this organization',
                organization: invitation.organization,
            });
        }

        // Create membership and update invitation in a transaction
        const [member] = await prisma.$transaction([
            prisma.member.create({
                data: {
                    userId: session.user.id,
                    organizationId: invitation.organizationId,
                    role: invitation.role,
                },
                include: {
                    organization: true,
                },
            }),
            prisma.invitation.update({
                where: { id: invitation.id },
                data: {
                    status: 'accepted',
                    acceptedAt: new Date(),
                },
            }),
        ]);

        // Create MemberRole if invitation carries a roleId
        if (invitation.roleId) {
            const acceptingUserId = session.user.id;
            const memberRecord = await prisma.member.findUnique({
                where: { userId_organizationId: { userId: acceptingUserId, organizationId: invitation.organizationId } },
                select: { id: true },
            });
            if (memberRecord) {
                await prisma.memberRole.upsert({
                    where: { memberId_roleId: { memberId: memberRecord.id, roleId: invitation.roleId } },
                    update: {},
                    create: { memberId: memberRecord.id, roleId: invitation.roleId },
                });
            }
        }

        // Aceptar una invitación sólo da acceso: no se publica nada.

        return NextResponse.json({
            success: true,
            message: `You are now a ${invitation.role} of ${invitation.organization.name}`,
            member,
        });
    } catch (error) {
        console.error('Failed to accept invitation:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
