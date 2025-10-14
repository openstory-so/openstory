/**
 * Team service layer
 * Business logic for team operations
 */

import {
  getTeamById,
  getUserTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  getTeamMember,
  updateTeamMemberRole,
  createTeamInvitation,
  getTeamInvitations,
} from "@/db/queries/teams";
import {
  requireTeamMember,
  requireTeamAdmin,
  requireTeamOwner,
} from "@/lib/auth/rbac";
import type { User } from "@/lib/auth/config";
import type {
  CreateTeamInput,
  UpdateTeamInput,
  AddTeamMemberInput,
  UpdateTeamMemberRoleInput,
  CreateTeamInvitationInput,
} from "@/schemas/teams";
import { NotFoundError, ConflictError } from "@/plugins/error";

export class TeamService {
  /**
   * Get team by ID
   * Requires team membership
   */
  static async getById(teamId: string, user: User) {
    const team = await getTeamById(teamId);

    if (!team) {
      throw new NotFoundError("Team not found");
    }

    // Check team membership
    await requireTeamMember(user, teamId);

    return team;
  }

  /**
   * List user's teams
   */
  static async listByUser(user: User) {
    return await getUserTeams(user.id);
  }

  /**
   * Create a new team
   * User becomes the owner
   */
  static async create(input: CreateTeamInput, user: User) {
    // Create team with user as owner
    const team = await createTeam({
      name: input.name,
      slug: input.slug,
    });

    if (!team) {
      throw new Error("Failed to create team");
    }

    // Add user as owner
    await addTeamMember({
      teamId: team.id,
      userId: user.id,
      role: "owner",
    });

    return team;
  }

  /**
   * Update a team
   * Requires team admin role
   */
  static async update(teamId: string, input: UpdateTeamInput, user: User) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    // Update team
    const updated = await updateTeam(teamId, {
      name: input.name,
      slug: input.slug,
    });

    return updated;
  }

  /**
   * Delete a team
   * Requires team owner role
   */
  static async delete(teamId: string, user: User) {
    // Check team owner role
    await requireTeamOwner(user, teamId);

    // Delete team (cascades to members, sequences, styles, etc.)
    await deleteTeam(teamId);

    return { success: true };
  }

  /**
   * Add a member to a team
   * Requires team admin role
   */
  static async addMember(
    teamId: string,
    input: AddTeamMemberInput,
    user: User
  ) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    // Check if user is already a member
    const existingMember = await getTeamMember(teamId, input.userId);
    if (existingMember) {
      throw new ConflictError("User is already a team member");
    }

    // Add member
    const member = await addTeamMember({
      teamId,
      userId: input.userId,
      role: input.role,
    });

    return member;
  }

  /**
   * Remove a member from a team
   * Requires team admin role
   */
  static async removeMember(
    teamId: string,
    userId: string,
    user: User
  ) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    // Cannot remove yourself
    if (userId === user.id) {
      throw new ConflictError("Cannot remove yourself from the team");
    }

    // Remove member
    await removeTeamMember(teamId, userId);

    return { success: true };
  }

  /**
   * Update a member's role
   * Requires team admin role
   */
  static async updateMemberRole(
    teamId: string,
    userId: string,
    input: UpdateTeamMemberRoleInput,
    user: User
  ) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    // Cannot change your own role
    if (userId === user.id) {
      throw new ConflictError("Cannot change your own role");
    }

    // Update role
    const member = await updateTeamMemberRole(teamId, userId, input.role);

    return member;
  }

  /**
   * Create a team invitation
   * Requires team admin role
   */
  static async createInvitation(
    teamId: string,
    input: CreateTeamInvitationInput,
    user: User
  ) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    // Generate unique invitation token
    const token = crypto.randomUUID();

    // Create invitation
    const invitation = await createTeamInvitation({
      teamId,
      email: input.email,
      role: input.role,
      invitedBy: user.id,
      token,
      expiresAt: input.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    return invitation;
  }

  /**
   * List team invitations
   * Requires team admin role
   */
  static async listInvitations(teamId: string, user: User) {
    // Check team admin role
    await requireTeamAdmin(user, teamId);

    return await getTeamInvitations(teamId);
  }
}

