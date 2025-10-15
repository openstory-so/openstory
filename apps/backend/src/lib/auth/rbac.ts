/**
 * Role-Based Access Control (RBAC) utilities
 * Team-based authorization helpers
 */

import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "@/db";
import { teamMembers } from "@/db/schema";
import { requireAuth } from "@/plugins/auth";
import { AuthorizationError, NotFoundError } from "@/plugins/error";
import type { User } from "./config";

/**
 * Team roles in order of privilege (lowest to highest)
 */
export const TEAM_ROLES = ["viewer", "member", "admin", "owner"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Check if a role has sufficient privilege
 */
export function hasRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  const userRoleIndex = TEAM_ROLES.indexOf(userRole);
  const requiredRoleIndex = TEAM_ROLES.indexOf(requiredRole);
  return userRoleIndex >= requiredRoleIndex;
}

/**
 * Get user's role in a team
 */
export async function getUserTeamRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
  });

  return membership?.role || null;
}

/**
 * Check if user is a member of a team
 */
export async function isTeamMember(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const role = await getUserTeamRole(userId, teamId);
  return role !== null;
}

/**
 * Check if user can access a team (alias for isTeamMember)
 */
export async function canAccessTeam(
  user: User,
  teamId: string,
): Promise<boolean> {
  return isTeamMember(user.id, teamId);
}

/**
 * Require user to be a member of a team
 * Throws AuthorizationError if not a member
 */
export async function requireTeamMember(
  user: User,
  teamId: string,
): Promise<TeamRole> {
  const role = await getUserTeamRole(user.id, teamId);

  if (!role) {
    throw new AuthorizationError("You do not have access to this team");
  }

  return role;
}

/**
 * Require user to have a specific role or higher
 * Throws AuthorizationError if insufficient privilege
 */
export async function requireTeamRole(
  user: User,
  teamId: string,
  requiredRole: TeamRole,
): Promise<TeamRole> {
  const userRole = await requireTeamMember(user, teamId);

  if (!hasRole(userRole, requiredRole)) {
    throw new AuthorizationError(
      `This action requires ${requiredRole} role or higher`,
    );
  }

  return userRole;
}

/**
 * Require user to be a team admin
 */
export async function requireTeamAdmin(
  user: User,
  teamId: string,
): Promise<TeamRole> {
  return await requireTeamRole(user, teamId, "admin");
}

/**
 * Require user to be a team owner
 */
export async function requireTeamOwner(
  user: User,
  teamId: string,
): Promise<TeamRole> {
  return await requireTeamRole(user, teamId, "owner");
}

/**
 * Elysia plugin: Require team member access
 * Extracts teamId from params and checks membership
 */
export const requireTeamMemberPlugin = new Elysia({
  name: "require-team-member",
})
  .use(requireAuth)
  .derive(async (context) => {
    const { user, params } = context as any;
    const teamId = params.teamId;

    if (!teamId) {
      throw new NotFoundError("Team ID not found in request");
    }

    const role = await requireTeamMember(user, teamId);

    return {
      teamId,
      teamRole: role,
    };
  });

/**
 * Elysia plugin: Require team admin access
 */
export const requireTeamAdminPlugin = new Elysia({
  name: "require-team-admin",
})
  .use(requireAuth)
  .derive(async (context) => {
    const { user, params } = context as any;
    const teamId = params.teamId;

    if (!teamId) {
      throw new NotFoundError("Team ID not found in request");
    }

    const role = await requireTeamAdmin(user, teamId);

    return {
      teamId,
      teamRole: role,
    };
  });

/**
 * Elysia plugin: Require team owner access
 */
export const requireTeamOwnerPlugin = new Elysia({
  name: "require-team-owner",
})
  .use(requireAuth)
  .derive(async (context) => {
    const { user, params } = context as any;
    const teamId = params.teamId;

    if (!teamId) {
      throw new NotFoundError("Team ID not found in request");
    }

    const role = await requireTeamOwner(user, teamId);

    return {
      teamId,
      teamRole: role,
    };
  });
