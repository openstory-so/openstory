/**
 * Authorization Utilities for Server Actions
 *
 * Provides centralized authentication and authorization functions for Next.js Server Actions.
 * These utilities handle user authentication, team membership verification, and role-based access control.
 *
 * @module lib/auth/action-utils
 */

import { MOTION_ACCESS_DENIED_MESSAGE } from "@/constants";
import type { User } from "@/lib/auth/config";
import type { TeamRole } from "@/lib/auth/constants";
import { hasMinimumRole } from "@/lib/auth/constants";
import { getUserRole } from "@/lib/auth/permissions";
import { getUser } from "@/lib/auth/server";

/**
 * Get the current authenticated user
 *
 * @throws {Error} If no user session exists
 * @returns {Promise<User>} The authenticated user object
 *
 * @example
 * ```typescript
 * const user = await requireUser();
 * console.log(user.id, user.email);
 * ```
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();

  if (!user) {
    throw new Error("Authentication required");
  }

  return user;
}

/**
 * Get the current authenticated non-anonymous user
 *
 * Anonymous users are blocked from certain operations (e.g., motion generation).
 * This function ensures the user has a full account.
 *
 * @throws {Error} If no user session exists or user is anonymous
 * @returns {Promise<User>} The authenticated non-anonymous user object
 *
 * @example
 * ```typescript
 * const user = await requireAuthenticatedUser();
 * // User is guaranteed to have a full account (not anonymous)
 * ```
 */
export async function requireAuthenticatedUser(): Promise<User> {
  const user = await requireUser();

  if (user.isAnonymous === true) {
    throw new Error("Account required: please sign up or sign in to continue");
  }

  return user;
}

/**
 * Verify user has access to a team with at least the specified role
 *
 * Checks if the user is a member of the team and has the minimum required role.
 * Role hierarchy: viewer < member < admin < owner
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @param {TeamRole} minRole - Minimum required role (default: "member")
 * @throws {Error} If user is not a team member or doesn't have sufficient role
 * @returns {Promise<TeamRole>} The user's actual role in the team
 *
 * @example
 * ```typescript
 * const role = await requireTeamMemberAccess(user.id, teamId, "member");
 * console.log(`User has ${role} role`);
 * ```
 */
export async function requireTeamMemberAccess(
  userId: string,
  teamId: string,
  minRole: TeamRole = "member",
): Promise<TeamRole> {
  const role = await getUserRole(userId, teamId);

  if (!role) {
    throw new Error("Access denied: not a member of this team");
  }

  // Check if user has minimum required role using shared constants
  if (!hasMinimumRole(role, minRole)) {
    throw new Error(`Access denied: ${minRole} role or higher required`);
  }

  return role;
}

/**
 * Verify user has admin or owner access to a team
 *
 * Convenience function for operations that require admin privileges.
 * Equivalent to `requireTeamMemberAccess(userId, teamId, "admin")`
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @throws {Error} If user is not an admin or owner of the team
 * @returns {Promise<TeamRole>} The user's actual role (admin or owner)
 *
 * @example
 * ```typescript
 * const role = await requireTeamAdminAccess(user.id, teamId);
 * // User is guaranteed to be admin or owner
 * ```
 */
export async function requireTeamAdminAccess(
  userId: string,
  teamId: string,
): Promise<TeamRole> {
  return requireTeamMemberAccess(userId, teamId, "admin");
}

/**
 * Verify user is the owner of a team
 *
 * Convenience function for operations that require owner privileges.
 * Equivalent to `requireTeamMemberAccess(userId, teamId, "owner")`
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @throws {Error} If user is not the owner of the team
 * @returns {Promise<TeamRole>} The user's role (always "owner")
 *
 * @example
 * ```typescript
 * await requireTeamOwnerAccess(user.id, teamId);
 * // User is guaranteed to be the team owner
 * ```
 */
export async function requireTeamOwnerAccess(
  userId: string,
  teamId: string,
): Promise<TeamRole> {
  return requireTeamMemberAccess(userId, teamId, "owner");
}

/**
 * Verify user can generate motion (authenticated, non-anonymous)
 *
 * Motion generation requires a full account (not anonymous).
 * This function validates the user meets this requirement.
 *
 * @param {User} user - The user object to validate
 * @throws {Error} If user is anonymous (with specific motion access denied message)
 *
 * @example
 * ```typescript
 * const user = await requireUser();
 * validateMotionAccess(user);
 * // User can now generate motion
 * ```
 */
export function validateMotionAccess(user: User): void {
  if (user.isAnonymous === true) {
    throw new Error(MOTION_ACCESS_DENIED_MESSAGE);
  }
}

/**
 * Get authenticated user and verify team access in one call
 *
 * Convenience function that combines user authentication and team access verification.
 * Useful for Server Actions that need both.
 *
 * @param {string} teamId - The team ID to check access for
 * @param {TeamRole} minRole - Minimum required role (default: "member")
 * @throws {Error} If authentication fails or user doesn't have team access
 * @returns {Promise<{ user: User; role: TeamRole }>} User and their role
 *
 * @example
 * ```typescript
 * const { user, role } = await requireUserWithTeamAccess(teamId, "admin");
 * console.log(`${user.email} has ${role} access`);
 * ```
 */
export async function requireUserWithTeamAccess(
  teamId: string,
  minRole: TeamRole = "member",
): Promise<{ user: User; role: TeamRole }> {
  const user = await requireUser();
  const role = await requireTeamMemberAccess(user.id, teamId, minRole);

  return { user, role };
}

/**
 * Get authenticated non-anonymous user and verify team access
 *
 * Combines authenticated user check and team access verification.
 * Useful for operations that require both a full account and team membership.
 *
 * @param {string} teamId - The team ID to check access for
 * @param {TeamRole} minRole - Minimum required role (default: "member")
 * @throws {Error} If user is anonymous or doesn't have team access
 * @returns {Promise<{ user: User; role: TeamRole }>} User and their role
 *
 * @example
 * ```typescript
 * const { user, role } = await requireAuthenticatedUserWithTeamAccess(teamId);
 * // User has full account and is a team member
 * ```
 */
export async function requireAuthenticatedUserWithTeamAccess(
  teamId: string,
  minRole: TeamRole = "member",
): Promise<{ user: User; role: TeamRole }> {
  const user = await requireAuthenticatedUser();
  const role = await requireTeamMemberAccess(user.id, teamId, minRole);

  return { user, role };
}

/**
 * Check if user has team access without throwing
 *
 * Non-throwing version of requireTeamMemberAccess.
 * Useful for conditional logic where you want to check access without error handling.
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @param {TeamRole} minRole - Minimum required role (default: "member")
 * @returns {Promise<{ hasAccess: boolean; role: TeamRole | null }>} Access status and role
 *
 * @example
 * ```typescript
 * const { hasAccess, role } = await checkTeamAccess(user.id, teamId, "admin");
 * if (hasAccess) {
 *   console.log(`User has ${role} access`);
 * }
 * ```
 */
export async function checkTeamAccess(
  userId: string,
  teamId: string,
  minRole: TeamRole = "member",
): Promise<{ hasAccess: boolean; role: TeamRole | null }> {
  try {
    const role = await requireTeamMemberAccess(userId, teamId, minRole);
    return { hasAccess: true, role };
  } catch {
    return { hasAccess: false, role: null };
  }
}
