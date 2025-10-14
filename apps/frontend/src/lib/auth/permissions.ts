/**
 * Authorization and Permission Utilities for RBAC
 * Provides role-based access control functions for team resources
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { User } from "./config";
import { auth } from "./config";

// Role hierarchy (higher number = more permissions)
const ROLE_HIERARCHY = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
} as const;

export type TeamRole = keyof typeof ROLE_HIERARCHY;

interface RoleCheckResult {
  hasPermission: boolean;
  userRole: TeamRole | null;
  userId: string;
}

export interface AuthError {
  success: false;
  message: string;
  status: number;
  timestamp: string;
}

/**
 * Get user's role for a specific team
 * Returns null if user is not a member of the team
 */
export async function getUserRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const supabase = createServerClient();

  const { data: membership, error } = await supabase
    .from("team_members")
    .select("role")
    .eq("user_id", userId)
    .eq("team_id", teamId)
    .single();

  if (error || !membership) {
    return null;
  }

  return membership.role as TeamRole;
}

/**
 * Check if user has at least the specified role level
 */
function hasMinimumRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Get authenticated user from request
 */
async function getAuthenticatedUser(request: Request): Promise<User | null> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    return session?.user || null;
  } catch (error) {
    console.error("[Permissions] Failed to get user:", error);
    return null;
  }
}

/**
 * Check if user can manage team settings (admin or owner only)
 */
export async function canManageTeam(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const role = await getUserRole(userId, teamId);

  if (!role) {
    return false;
  }

  return hasMinimumRole(role, "admin");
}

/**
 * Check if user can delete team resources (admin or owner only)
 */
export async function canDeleteResource(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const role = await getUserRole(userId, teamId);

  if (!role) {
    return false;
  }

  return hasMinimumRole(role, "admin");
}

/**
 * Check if user is owner of the team
 */
export async function isTeamOwner(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const role = await getUserRole(userId, teamId);
  return role === "owner";
}

/**
 * Require user to have admin or owner role for a team
 * Returns user and role info or throws error response
 */
export async function requireAdmin(
  request: Request,
  teamId: string,
): Promise<{ user: User; role: TeamRole; teamId: string }> {
  const user = await getAuthenticatedUser(request);

  if (!user) {
    throw NextResponse.json(
      {
        success: false,
        message: "Authentication required",
        status: 401,
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    );
  }

  const role = await getUserRole(user.id, teamId);

  if (!role) {
    throw NextResponse.json(
      {
        success: false,
        message: "Access denied: not a member of this team",
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  if (!hasMinimumRole(role, "admin")) {
    throw NextResponse.json(
      {
        success: false,
        message: "Access denied: admin or owner role required",
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  return { user, role, teamId };
}

/**
 * Require user to have owner role for a team
 * Returns user and role info or throws error response
 */
export async function requireOwner(
  request: Request,
  teamId: string,
): Promise<{ user: User; role: TeamRole; teamId: string }> {
  const user = await getAuthenticatedUser(request);

  if (!user) {
    throw NextResponse.json(
      {
        success: false,
        message: "Authentication required",
        status: 401,
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    );
  }

  const role = await getUserRole(user.id, teamId);

  if (!role) {
    throw NextResponse.json(
      {
        success: false,
        message: "Access denied: not a member of this team",
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  if (role !== "owner") {
    throw NextResponse.json(
      {
        success: false,
        message: "Access denied: owner role required",
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  return { user, role, teamId };
}

/**
 * Check role and return result without throwing
 * Useful for conditional logic in Server Actions
 */
export async function checkUserRole(
  userId: string,
  teamId: string,
  requiredRole: TeamRole,
): Promise<RoleCheckResult> {
  const userRole = await getUserRole(userId, teamId);

  if (!userRole) {
    return {
      hasPermission: false,
      userRole: null,
      userId,
    };
  }

  return {
    hasPermission: hasMinimumRole(userRole, requiredRole),
    userRole,
    userId,
  };
}

/**
 * Verify user has permission to access a resource owned by a team
 * Returns team ID if user has access, throws error otherwise
 */
export async function verifyTeamResourceAccess(
  request: Request,
  resourceTeamId: string,
  requiredRole: TeamRole = "member",
): Promise<{ user: User; role: TeamRole; teamId: string }> {
  const user = await getAuthenticatedUser(request);

  if (!user) {
    throw NextResponse.json(
      {
        success: false,
        message: "Authentication required",
        status: 401,
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    );
  }

  const role = await getUserRole(user.id, resourceTeamId);

  if (!role) {
    throw NextResponse.json(
      {
        success: false,
        message: "Access denied: not a member of this team",
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  if (!hasMinimumRole(role, requiredRole)) {
    throw NextResponse.json(
      {
        success: false,
        message: `Access denied: ${requiredRole} role or higher required`,
        status: 403,
        timestamp: new Date().toISOString(),
      },
      { status: 403 },
    );
  }

  return { user, role, teamId: resourceTeamId };
}

/**
 * Get all teams for a user with their roles
 */
export async function getUserTeams(userId: string): Promise<
  Array<{
    teamId: string;
    role: TeamRole;
    teamName: string;
    joinedAt: string;
  }>
> {
  const supabase = createServerClient();

  const { data: memberships, error } = await supabase
    .from("team_members")
    .select("team_id, role, joined_at, teams(name)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true });

  if (error || !memberships) {
    return [];
  }

  return memberships.map((m) => ({
    teamId: m.team_id,
    role: m.role as TeamRole,
    teamName: (m.teams as { name: string })?.name || "Unknown Team",
    joinedAt: m.joined_at,
  }));
}
