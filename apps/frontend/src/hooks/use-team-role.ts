"use client";

import { useUser } from "./use-user";

export type TeamRole = "owner" | "admin" | "member" | "viewer";

// Role hierarchy for permission checks
const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

/**
 * Hook to access current user's team role and permission checks
 */
export function useTeamRole() {
  const { data: userData, isLoading, error } = useUser();

  const role = (userData?.teamRole as TeamRole) || null;
  const teamId = userData?.teamId || null;
  const teamName = userData?.teamName || null;

  /**
   * Check if user has at least the specified role level
   */
  const hasMinimumRole = (requiredRole: TeamRole): boolean => {
    if (!role) return false;
    return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole];
  };

  /**
   * Check if user is an admin or owner
   */
  const isAdmin = (): boolean => {
    return hasMinimumRole("admin");
  };

  /**
   * Check if user is the team owner
   */
  const isOwner = (): boolean => {
    return role === "owner";
  };

  /**
   * Check if user can manage team settings
   */
  const canManageTeam = (): boolean => {
    return isAdmin();
  };

  /**
   * Check if user can delete resources
   */
  const canDeleteResource = (): boolean => {
    return isAdmin();
  };

  /**
   * Check if user can invite members
   */
  const canInviteMembers = (): boolean => {
    return isAdmin();
  };

  /**
   * Check if user can remove members
   */
  const canRemoveMembers = (): boolean => {
    return isAdmin();
  };

  /**
   * Check if user can change member roles
   */
  const canChangeRoles = (): boolean => {
    return isOwner();
  };

  return {
    role,
    teamId,
    teamName,
    isLoading,
    error,
    // Permission checks
    hasMinimumRole,
    isAdmin: isAdmin(),
    isOwner: isOwner(),
    canManageTeam: canManageTeam(),
    canDeleteResource: canDeleteResource(),
    canInviteMembers: canInviteMembers(),
    canRemoveMembers: canRemoveMembers(),
    canChangeRoles: canChangeRoles(),
  };
}
