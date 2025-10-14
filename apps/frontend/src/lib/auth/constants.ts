/**
 * Shared authentication and authorization constants
 *
 * This file contains all shared constants used across the auth system
 * to ensure consistency and avoid duplication.
 */

/**
 * Role hierarchy for team-based access control
 * Higher numbers = more permissions
 */
export const ROLE_HIERARCHY = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
} as const;

/**
 * Team role type derived from ROLE_HIERARCHY keys
 */
export type TeamRole = keyof typeof ROLE_HIERARCHY;

/**
 * Get the numeric level for a role
 */
export function getRoleLevel(role: TeamRole): number {
  return ROLE_HIERARCHY[role];
}

/**
 * Check if a role has sufficient permissions
 */
export function hasMinimumRole(
  userRole: TeamRole,
  requiredRole: TeamRole,
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Get the highest role from a list of roles
 */
export function getHighestRole(roles: TeamRole[]): TeamRole | null {
  if (roles.length === 0) return null;

  return roles.reduce((highest, current) => {
    return ROLE_HIERARCHY[current] > ROLE_HIERARCHY[highest]
      ? current
      : highest;
  });
}

/**
 * Invitation token configuration
 */
export const INVITATION_CONFIG = {
  TOKEN_BYTES: 32,
  TOKEN_ENCODING: "base64url" as const, // URL-safe encoding
  EXPIRY_DAYS: 7,
} as const;

/**
 * Session configuration
 */
export const SESSION_CONFIG = {
  EXPIRES_IN: 60 * 60 * 24 * 365, // 1 year
  UPDATE_AGE: 60 * 60 * 24, // 1 day
  COOKIE_CACHE_MAX_AGE: 5 * 60, // 5 minutes
} as const;
