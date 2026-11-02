/**
 * Scoped Team Management Sub-module
 * Team-scoped member management, invitations, and role updates.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { INVITATION_CONFIG } from '@/platform/server/auth/constants';
import type { TeamRole } from '@/platform/server/auth/permissions';
import { getUserRole } from '@/platform/server/auth/permissions';
import { member, teamInvitations, user } from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import crypto from 'node:crypto';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'db', 'team-management']);

async function findMembership(
  db: Database,
  organizationId: string,
  userId: string
) {
  const [row] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);
  return row;
}

type TeamMember = {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  role: string;
  joinedAt: Date;
};

type TeamInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  invitedBy: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
};

type AcceptInvitationParams = {
  token: string;
  userId: string;
};

/**
 * Read-only team management methods + acceptInvitation (needed by invitation flow).
 */
function createTeamManagementReadMethods(db: Database, organizationId: string) {
  /**
   * Billing contact = the team owner, not whichever member tripped the
   * debit — they may not be the one holding the card (#1499).
   */
  async function getOwnerEmail(): Promise<string | null> {
    const [row] = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(eq(member.organizationId, organizationId), eq(member.role, 'owner'))
      )
      .limit(1);
    return row?.email ?? null;
  }

  async function getMembers(): Promise<TeamMember[]> {
    const members: TeamMember[] = await db
      .select({
        userId: member.userId,
        email: user.email,
        name: user.name,
        image: user.image,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, organizationId))
      .orderBy(asc(member.createdAt));

    return members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      image: m.image,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  /**
   * Email for a team member, snapshotted onto workflow payloads at trigger
   * time (#1276). Null if they left the team or have no address.
   */
  async function getMemberEmail(memberUserId: string): Promise<string | null> {
    const [row] = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, memberUserId)
        )
      )
      .limit(1);
    return row?.email ?? null;
  }

  async function getInvitations(): Promise<Omit<TeamInvitation, 'token'>[]> {
    const invitations: Omit<TeamInvitation, 'token'>[] = await db
      .select({
        id: teamInvitations.id,
        organizationId: teamInvitations.organizationId,
        email: teamInvitations.email,
        role: teamInvitations.role,
        invitedBy: teamInvitations.invitedBy,
        status: teamInvitations.status,
        expiresAt: teamInvitations.expiresAt,
        createdAt: teamInvitations.createdAt,
        acceptedAt: teamInvitations.acceptedAt,
      })
      .from(teamInvitations)
      .where(eq(teamInvitations.organizationId, organizationId))
      .orderBy(asc(teamInvitations.createdAt));

    return invitations.map((inv) => ({
      id: inv.id,
      organizationId: inv.organizationId,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      acceptedAt: inv.acceptedAt ?? null,
    }));
  }

  /**
   * Accept a team invitation.
   * On ReadOnly because invitation flow has no user session with a known organizationId.
   */
  async function acceptInvitation(
    params: AcceptInvitationParams
  ): Promise<string> {
    const invitation = await db.query.teamInvitations.findFirst({
      where: { token: params.token },
    });

    if (!invitation) {
      throw new ValidationError('Invalid invitation token');
    }

    if (invitation.status !== 'pending') {
      throw new ValidationError('Invitation is no longer valid');
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      await db
        .update(teamInvitations)
        .set({ status: 'expired' })
        .where(eq(teamInvitations.id, invitation.id));

      throw new ValidationError('Invitation has expired');
    }

    const existingMember = await findMembership(
      db,
      invitation.organizationId,
      params.userId
    );

    if (existingMember) {
      throw new ValidationError(
        'You are already a member of this organization'
      );
    }

    await db.insert(member).values({
      id: generateId(),
      organizationId: invitation.organizationId,
      userId: params.userId,
      role: invitation.role,
      createdAt: new Date(),
    });

    try {
      await db
        .update(teamInvitations)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
        })
        .where(eq(teamInvitations.id, invitation.id));
    } catch (error) {
      logger.error('Failed to update invitation status:', { err: error });
    }

    return invitation.organizationId;
  }

  return {
    getMembers,
    getOwnerEmail,
    getMemberEmail,
    getInvitations,
    acceptInvitation,
  };
}

/**
 * Full team management — extends read methods with writes that auto-inject userId.
 */
export function createTeamManagementMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  const read = createTeamManagementReadMethods(db, organizationId);

  async function createInvitation(params: {
    email: string;
    role: 'member' | 'admin' | 'viewer';
  }): Promise<TeamInvitation> {
    const existingAuthUser = await db.query.user.findFirst({
      where: { email: params.email },
      columns: { id: true },
    });

    if (existingAuthUser) {
      const existingMember = await findMembership(
        db,
        organizationId,
        existingAuthUser.id
      );

      if (existingMember) {
        throw new ValidationError('User is already in this organization');
      }
    }

    const existingInvitation = await db.query.teamInvitations.findFirst({
      where: { organizationId, email: params.email, status: 'pending' },
      columns: { id: true },
    });

    if (existingInvitation) {
      throw new ValidationError(
        'An invitation has already been sent to this email'
      );
    }

    const token = crypto
      .randomBytes(INVITATION_CONFIG.TOKEN_BYTES)
      .toString(INVITATION_CONFIG.TOKEN_ENCODING);

    const expiresAt = new Date(
      Date.now() + INVITATION_CONFIG.EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        organizationId,
        email: params.email,
        role: params.role,
        invitedBy: userId,
        token,
        expiresAt,
      })
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (!invitation) {
      throw new Error('No invitation returned from database');
    }

    logger.info(
      `Invitation created for ${params.email}. Token should be sent via email.`
    );

    return {
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      acceptedAt: invitation.acceptedAt ?? null,
    };
  }

  async function removeMember(targetUserId: string): Promise<void> {
    if (userId === targetUserId) {
      throw new ValidationError(
        'You cannot remove yourself from the organization'
      );
    }

    const targetRole = await getUserRole(targetUserId, organizationId);
    if (!targetRole) {
      throw new ValidationError('User is not a member of this organization');
    }

    if (targetRole === 'owner') {
      throw new ValidationError('Cannot remove the organization owner');
    }

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, targetUserId)
        )
      );
  }

  async function updateMemberRole(
    targetUserId: string,
    newRole: TeamRole
  ): Promise<void> {
    if (userId === targetUserId) {
      throw new ValidationError('You cannot change your own role');
    }

    const currentRole = await getUserRole(targetUserId, organizationId);
    if (!currentRole) {
      throw new ValidationError('User is not a member of this organization');
    }

    if (currentRole === 'owner') {
      throw new ValidationError(
        "Cannot change the owner's role. Transfer ownership first."
      );
    }

    await db
      .update(member)
      .set({ role: newRole })
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, targetUserId)
        )
      );
  }

  return {
    ...read,
    createInvitation,
    removeMember,
    updateMemberRole,
  };
}
