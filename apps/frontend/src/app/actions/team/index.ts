"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  requireTeamAdminAccess,
  requireTeamMemberAccess,
  requireTeamOwnerAccess,
  requireUser,
} from "@/lib/auth/action-utils";
import { createActionErrorResponse } from "@/lib/errors";
import { teamService } from "@/lib/services/team.service";

// Validation schemas
const inviteMemberSchema = z.object({
  teamId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["member", "admin", "viewer"]).default("member"),
});

const removeMemberSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
});

const updateRoleSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  newRole: z.enum(["owner", "admin", "member", "viewer"]),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(1),
});

interface ActionResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Invite a new member to the team (admin/owner only)
 */
export async function inviteTeamMember(input: {
  teamId: string;
  email: string;
  role?: "member" | "admin" | "viewer";
}): Promise<ActionResponse<{ invitationId: string }>> {
  try {
    const validated = inviteMemberSchema.parse(input);
    const user = await requireUser();
    await requireTeamAdminAccess(user.id, validated.teamId);

    const invitation = await teamService.createInvitation({
      teamId: validated.teamId,
      email: validated.email,
      role: validated.role,
      invitedBy: user.id,
    });

    revalidatePath(`/teams/${validated.teamId}/members`);

    return {
      success: true,
      data: { invitationId: invitation.id },
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Accept a team invitation
 */
export async function acceptInvitation(input: {
  token: string;
}): Promise<ActionResponse<{ teamId: string }>> {
  try {
    const validated = acceptInvitationSchema.parse(input);
    const user = await requireUser();

    const teamId = await teamService.acceptInvitation({
      token: validated.token,
      userId: user.id,
    });

    revalidatePath(`/teams/${teamId}/members`);

    return {
      success: true,
      data: { teamId },
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Remove a member from the team (admin/owner only)
 */
export async function removeTeamMember(input: {
  teamId: string;
  userId: string;
}): Promise<ActionResponse> {
  try {
    const validated = removeMemberSchema.parse(input);
    const user = await requireUser();
    await requireTeamAdminAccess(user.id, validated.teamId);

    await teamService.removeMember({
      teamId: validated.teamId,
      userId: validated.userId,
      requestingUserId: user.id,
    });

    revalidatePath(`/teams/${validated.teamId}/members`);

    return { success: true };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Update a member's role (owner only)
 */
export async function updateMemberRole(input: {
  teamId: string;
  userId: string;
  newRole: "owner" | "admin" | "member" | "viewer";
}): Promise<ActionResponse> {
  try {
    const validated = updateRoleSchema.parse(input);
    const user = await requireUser();
    await requireTeamOwnerAccess(user.id, validated.teamId);

    await teamService.updateMemberRole({
      teamId: validated.teamId,
      userId: validated.userId,
      newRole: validated.newRole,
      requestingUserId: user.id,
    });

    revalidatePath(`/teams/${validated.teamId}/members`);

    return { success: true };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Get all members of a team with their roles
 */
export async function getTeamMembers(teamId: string): Promise<
  ActionResponse<
    Array<{
      userId: string;
      email: string;
      fullName: string | null;
      avatarUrl: string | null;
      role: string;
      joinedAt: string;
    }>
  >
> {
  try {
    const user = await requireUser();
    await requireTeamMemberAccess(user.id, teamId);

    const members = await teamService.getMembers(teamId);

    return {
      success: true,
      data: members,
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}

/**
 * Get pending invitations for a team (admin/owner only)
 */
export async function getTeamInvitations(teamId: string): Promise<
  ActionResponse<
    Array<{
      id: string;
      email: string;
      role: string;
      invitedBy: string;
      status: string;
      expiresAt: string;
      createdAt: string;
    }>
  >
> {
  try {
    const user = await requireUser();
    await requireTeamAdminAccess(user.id, teamId);

    const invitations = await teamService.getInvitations(teamId);

    return {
      success: true,
      data: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        invitedBy: inv.invitedBy,
        status: inv.status,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
      })),
    };
  } catch (error) {
    return createActionErrorResponse(error);
  }
}
