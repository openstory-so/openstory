/**
 * BetterAuth User Server Actions
 * Replaces Supabase Auth user management with BetterAuth
 */

"use server";

import { createAnonymousSession, getSession, getUser } from "@/lib/auth/server";
import { createServerClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/database";
import type {
  TeamAccessResponse,
  TeamResponse,
  TeamsResponse,
  UserResponse,
} from "./types";

/**
 * Get current user session and profile data
 * Handles both authenticated and anonymous users
 */
export async function getCurrentUser(): Promise<UserResponse> {
  try {
    const session = await getSession();

    if (!session?.user) {
      // No session exists, create anonymous session
      return await createAnonymousUserSession();
    }

    const authUser = session.user;
    const isAnonymous = authUser.isAnonymous === true;

    // Get user profile from database
    const supabase = createServerClient();
    const { data: userProfile, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", authUser.id)
      .single();

    if (error || !userProfile) {
      // User doesn't exist in database, create them
      const createResult = await ensureUserAndTeam(authUser);
      if (!createResult.success) {
        return {
          success: false,
          error: createResult.error || "Failed to create user profile",
        };
      }

      if (!createResult.data) {
        return {
          success: false,
          error: "Failed to create user profile",
        };
      }

      return {
        success: true,
        data: {
          user: createResult.data,
          isAuthenticated: !isAnonymous,
          isAnonymous,
        },
      };
    }

    return {
      success: true,
      data: {
        user: userProfile,
        isAuthenticated: !isAnonymous,
        isAnonymous,
      },
    };
  } catch (error) {
    console.error("[getCurrentUser] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get user",
    };
  }
}

/**
 * Create anonymous user session
 */
async function createAnonymousUserSession(): Promise<UserResponse> {
  try {
    const session = await createAnonymousSession();

    if (!session?.user) {
      return {
        success: false,
        error: "Failed to create anonymous session",
      };
    }

    const authUser = session.user;

    // Ensure user has database record and team
    const createResult = await ensureUserAndTeam(authUser);
    if (!createResult.success) {
      return {
        success: false,
        error: createResult.error || "Failed to create anonymous user",
      };
    }

    if (!createResult.data) {
      return {
        success: false,
        error: "Failed to create anonymous user profile",
      };
    }

    return {
      success: true,
      data: {
        user: createResult.data,
        isAuthenticated: false,
        isAnonymous: true,
      },
    };
  } catch (error) {
    console.error("[createAnonymousUserSession] Error:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to create anonymous session",
    };
  }
}

/**
 * Ensure user exists in database with team membership
 * NOTE: Team creation is handled automatically by the sync_betterauth_to_users trigger
 */
async function ensureUserAndTeam(authUser: {
  id: string;
  name?: string | null;
}): Promise<{
  success: boolean;
  data?: UserProfile;
  error?: string;
}> {
  const supabase = createServerClient();

  try {
    // Retry logic: The BetterAuth trigger needs time to create user and team
    // Try up to 3 times with short delays (~300ms worst case)
    const maxRetries = 3;
    const baseDelay = 50; // Start with 50ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Single query with JOIN - more efficient than separate queries
      const { data: userWithTeam } = await supabase
        .from("users")
        .select(
          `
          *,
          team_members!inner (
            team_id,
            role
          )
        `,
        )
        .eq("id", authUser.id)
        .maybeSingle();

      // Early exit if user and team membership both exist
      if (userWithTeam?.team_members) {
        return { success: true, data: userWithTeam };
      }

      console.log(
        `[ensureUserAndTeam] User or team not ready yet (attempt ${attempt + 1}/${maxRetries})`,
      );

      // Only wait if we're going to retry
      // Linear backoff with jitter: ~50ms, ~100ms, ~150ms
      if (attempt < maxRetries - 1) {
        const jitter = Math.random() * 20; // 0-20ms random jitter
        const delay = baseDelay * (attempt + 1) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    console.error(
      "[ensureUserAndTeam] User or team not found after all retries",
    );
    return {
      success: false,
      error:
        "Failed to initialize user profile. The database trigger may not be running. Please check your Supabase logs.",
    };
  } catch (error) {
    console.error("[ensureUserAndTeam] Unexpected error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unexpected error",
    };
  }
}

/**
 * Get user's team information with role
 */
export async function getUserTeam(): Promise<TeamResponse> {
  try {
    const user = await getUser();

    if (!user) {
      return {
        success: false,
        error: "Authentication required",
      };
    }

    const supabase = createServerClient();
    const { data: membership, error } = await supabase
      .from("team_members")
      .select("team_id, role, teams(name)")
      .eq("user_id", user.id)
      .order("role", { ascending: false }) // Prefer owner/admin roles
      .limit(1)
      .single();

    if (error || !membership) {
      return {
        success: false,
        error: "No team membership found",
      };
    }

    const teamName =
      membership.teams &&
      typeof membership.teams === "object" &&
      "name" in membership.teams
        ? (membership.teams.name as string)
        : "My Team";

    return {
      success: true,
      data: {
        teamId: membership.team_id,
        role: membership.role,
        teamName,
      },
    };
  } catch (error) {
    console.error("[getUserTeam] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get team",
    };
  }
}

/**
 * Get all teams for the current user with roles
 */
export async function getUserTeams(): Promise<TeamsResponse> {
  try {
    const user = await getUser();

    if (!user) {
      return {
        success: false,
        error: "Authentication required",
      };
    }

    const supabase = createServerClient();
    const { data: memberships, error } = await supabase
      .from("team_members")
      .select("team_id, role, joined_at, teams(name)")
      .eq("user_id", user.id)
      .order("joined_at", { ascending: true });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      data: (memberships || []).map((m) => {
        const teamName =
          m.teams && typeof m.teams === "object" && "name" in m.teams
            ? (m.teams.name as string)
            : "Unknown Team";

        return {
          teamId: m.team_id,
          role: m.role,
          teamName,
          joinedAt: m.joined_at,
        };
      }),
    };
  } catch (error) {
    console.error("[getUserTeams] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get teams",
    };
  }
}

/**
 * Check if user has access to a team resource
 */
export async function checkUserTeamAccess(
  teamId: string,
): Promise<TeamAccessResponse> {
  try {
    const teamResult = await getUserTeam();

    if (!teamResult.success) {
      return {
        success: false,
        hasAccess: false,
        error: teamResult.error,
      };
    }

    const hasAccess = teamResult.data?.teamId === teamId;

    return {
      success: true,
      hasAccess,
    };
  } catch (error) {
    console.error("[checkUserTeamAccess] Error:", error);
    return {
      success: false,
      hasAccess: false,
      error: error instanceof Error ? error.message : "Failed to check access",
    };
  }
}
