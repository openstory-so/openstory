/**
 * Team Service Layer
 *
 * Handles all team-related business logic including member management,
 * invitations, and role updates. This service contains pure business logic
 * with no authentication or authorization checks (caller's responsibility).
 *
 * @module lib/services/team.service
 */

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITATION_CONFIG } from "@/lib/auth/constants";
import type { TeamRole } from "@/lib/auth/permissions";
import { getUserRole } from "@/lib/auth/permissions";
import { ValidationError } from "@/lib/errors";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

// Type definitions
export interface TeamMember {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: string;
  joinedAt: string;
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  email: string;
  role: string;
  invitedBy: string;
  // SECURITY: Token should NOT be included in API responses
  // It should only be sent via secure email channel
  status: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface CreateInvitationParams {
  teamId: string;
  email: string;
  role: "member" | "admin" | "viewer";
  invitedBy: string;
}

export interface AcceptInvitationParams {
  token: string;
  userId: string;
}

export interface RemoveMemberParams {
  teamId: string;
  userId: string;
  requestingUserId: string;
}

export interface UpdateMemberRoleParams {
  teamId: string;
  userId: string;
  newRole: TeamRole;
  requestingUserId: string;
}

/**
 * Team Service Class
 *
 * Provides business logic for team operations. All methods assume
 * the caller has already verified authentication and authorization.
 */
export class TeamService {
  constructor(
    private supabase: SupabaseClient<Database> = createServerClient(),
  ) {}

  /**
   * Create a team invitation
   *
   * @param params - Invitation parameters
   * @throws {ValidationError} If email already has pending invitation or is already a member
   * @throws {Error} If database operation fails
   * @returns The created invitation
   */
  async createInvitation(
    params: CreateInvitationParams,
  ): Promise<TeamInvitation> {
    // Check if email is already a team member
    const { data: betterAuthUser } = await this.supabase
      .from("user")
      .select("id")
      .eq("email", params.email)
      .single();

    if (betterAuthUser) {
      const { data: existingMember } = await this.supabase
        .from("team_members")
        .select("user_id")
        .eq("team_id", params.teamId)
        .eq("user_id", betterAuthUser.id)
        .single();

      if (existingMember) {
        throw new ValidationError("User is already a team member");
      }
    }

    // Check if there's already a pending invitation
    const { data: existingInvitation } = await this.supabase
      .from("team_invitations")
      .select("id")
      .eq("team_id", params.teamId)
      .eq("email", params.email)
      .eq("status", "pending")
      .single();

    if (existingInvitation) {
      throw new ValidationError(
        "An invitation has already been sent to this email",
      );
    }

    // Generate cryptographically secure, URL-safe invitation token
    const token = crypto
      .randomBytes(INVITATION_CONFIG.TOKEN_BYTES)
      .toString(INVITATION_CONFIG.TOKEN_ENCODING);

    // Calculate expiry date
    const expiresAt = new Date(
      Date.now() + INVITATION_CONFIG.EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Create invitation
    const { data: invitation, error } = await this.supabase
      .from("team_invitations")
      .insert({
        team_id: params.teamId,
        email: params.email,
        role: params.role,
        invited_by: params.invitedBy,
        token,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create invitation: ${error.message}`);
    }

    if (!invitation) {
      throw new Error("No invitation returned from database");
    }

    // TODO: Send invitation email with token
    // SECURITY: Token should ONLY be sent via email, never in API response
    // await this.emailService.sendInvitation(params.email, token);
    console.log(
      `[TeamService] Invitation created for ${params.email}. Token should be sent via email.`,
    );

    // SECURITY: Do NOT return token in response
    // Token should only be sent via secure email channel
    return {
      id: invitation.id,
      teamId: invitation.team_id,
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invited_by,
      status: invitation.status,
      expiresAt: invitation.expires_at,
      createdAt: invitation.created_at,
      acceptedAt: invitation.accepted_at,
    };
  }

  /**
   * Accept a team invitation
   *
   * @param params - Acceptance parameters
   * @throws {ValidationError} If invitation is invalid, expired, or user is already a member
   * @throws {Error} If database operation fails
   * @returns The team ID the user joined
   */
  async acceptInvitation(params: AcceptInvitationParams): Promise<string> {
    // Get invitation
    const { data: invitation, error: fetchError } = await this.supabase
      .from("team_invitations")
      .select("*")
      .eq("token", params.token)
      .single();

    if (fetchError || !invitation) {
      throw new ValidationError("Invalid invitation token");
    }

    // Check if invitation is still valid
    if (invitation.status !== "pending") {
      throw new ValidationError("Invitation is no longer valid");
    }

    if (new Date(invitation.expires_at) < new Date()) {
      // Mark as expired
      await this.supabase
        .from("team_invitations")
        .update({ status: "expired" })
        .eq("id", invitation.id);

      throw new ValidationError("Invitation has expired");
    }

    // Check if user is already a member
    const { data: existingMember } = await this.supabase
      .from("team_members")
      .select("user_id")
      .eq("team_id", invitation.team_id)
      .eq("user_id", params.userId)
      .single();

    if (existingMember) {
      throw new ValidationError("You are already a member of this team");
    }

    // Add user to team
    const { error: memberError } = await this.supabase
      .from("team_members")
      .insert({
        team_id: invitation.team_id,
        user_id: params.userId,
        role: invitation.role,
      });

    if (memberError) {
      throw new Error(`Failed to join team: ${memberError.message}`);
    }

    // Mark invitation as accepted
    const { error: updateError } = await this.supabase
      .from("team_invitations")
      .update({
        status: "accepted",
        accepted_at: new Date().toISOString(),
      })
      .eq("id", invitation.id);

    if (updateError) {
      console.error(
        "[TeamService] Failed to update invitation status:",
        updateError,
      );
      // Don't throw - user is already added to team
    }

    return invitation.team_id;
  }

  /**
   * Remove a member from a team
   *
   * @param params - Removal parameters
   * @throws {ValidationError} If user is not a member, is the owner, or trying to remove self
   * @throws {Error} If database operation fails
   */
  async removeMember(params: RemoveMemberParams): Promise<void> {
    // Prevent removing yourself
    if (params.requestingUserId === params.userId) {
      throw new ValidationError("You cannot remove yourself from the team");
    }

    // Get the target user's role
    const targetRole = await getUserRole(params.userId, params.teamId);
    if (!targetRole) {
      throw new ValidationError("User is not a member of this team");
    }

    // Prevent removing the owner
    if (targetRole === "owner") {
      throw new ValidationError("Cannot remove the team owner");
    }

    // Remove the member
    const { error } = await this.supabase
      .from("team_members")
      .delete()
      .eq("team_id", params.teamId)
      .eq("user_id", params.userId);

    if (error) {
      throw new Error(`Failed to remove member: ${error.message}`);
    }
  }

  /**
   * Update a team member's role
   *
   * @param params - Role update parameters
   * @throws {ValidationError} If user is not a member, is owner, or trying to change own role
   * @throws {Error} If database operation fails
   */
  async updateMemberRole(params: UpdateMemberRoleParams): Promise<void> {
    // Prevent changing your own role
    if (params.requestingUserId === params.userId) {
      throw new ValidationError("You cannot change your own role");
    }

    // Get the target user's current role
    const currentRole = await getUserRole(params.userId, params.teamId);
    if (!currentRole) {
      throw new ValidationError("User is not a member of this team");
    }

    // Prevent changing from owner role (there should only be one owner)
    if (currentRole === "owner") {
      throw new ValidationError(
        "Cannot change the owner's role. Transfer ownership first.",
      );
    }

    // Update the role
    const { error } = await this.supabase
      .from("team_members")
      .update({ role: params.newRole })
      .eq("team_id", params.teamId)
      .eq("user_id", params.userId);

    if (error) {
      throw new Error(`Failed to update role: ${error.message}`);
    }
  }

  /**
   * Get all members of a team
   *
   * @param teamId - The team ID
   * @throws {Error} If database operation fails
   * @returns Array of team members with their details
   */
  async getMembers(teamId: string): Promise<TeamMember[]> {
    // Get team members with Velro user data
    const { data: members, error } = await this.supabase
      .from("team_members")
      .select(
        `
        user_id,
        role,
        joined_at,
        users (
          full_name,
          avatar_url
        )
      `,
      )
      .eq("team_id", teamId)
      .order("joined_at", { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch team members: ${error.message}`);
    }

    // Get emails from BetterAuth user table
    const userIds = members?.map((m) => m.user_id) || [];
    const { data: betterAuthUsers } = await this.supabase
      .from("user")
      .select("id, email")
      .in("id", userIds);

    // Create email lookup map
    const emailMap = new Map(
      betterAuthUsers?.map((u) => [u.id, u.email]) || [],
    );

    return (members || []).map((m) => ({
      userId: m.user_id,
      email: emailMap.get(m.user_id) || "",
      fullName:
        (m.users as { full_name: string | null } | null)?.full_name || null,
      avatarUrl:
        (m.users as { avatar_url: string | null } | null)?.avatar_url || null,
      role: m.role,
      joinedAt: m.joined_at,
    }));
  }

  /**
   * Get all invitations for a team
   *
   * @param teamId - The team ID
   * @throws {Error} If database operation fails
   * @returns Array of team invitations
   */
  async getInvitations(
    teamId: string,
  ): Promise<Omit<TeamInvitation, "token">[]> {
    const { data: invitations, error } = await this.supabase
      .from("team_invitations")
      .select("*")
      .eq("team_id", teamId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch invitations: ${error.message}`);
    }

    return (invitations || []).map((inv) => ({
      id: inv.id,
      teamId: inv.team_id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invited_by,
      status: inv.status,
      expiresAt: inv.expires_at,
      createdAt: inv.created_at,
      acceptedAt: inv.accepted_at,
    }));
  }
}

// Singleton instance
export const teamService = new TeamService();
