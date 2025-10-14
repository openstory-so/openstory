/**
 * Server-side authentication utilities for BetterAuth
 * Provides session management for Server Actions and API routes
 */

import { headers } from "next/headers";
import type { Session, User } from "./config";
import { auth } from "./config";
import type { TeamRole } from "./constants";
import { getHighestRole } from "./constants";

/**
 * Get the current session from server context
 * Works in Server Actions, API routes, and Server Components
 */
export async function getSession(): Promise<Session | null> {
  try {
    const headersList = await headers();
    const session = await auth.api.getSession({
      headers: headersList,
    });

    return session;
  } catch (error) {
    console.error("[Auth] Failed to get session:", error);
    return null;
  }
}

/**
 * Get the current user from server context
 * Returns null if not authenticated
 */
export async function getUser(): Promise<User | null> {
  const session = await getSession();
  return session?.user || null;
}

/**
 * Require authentication - throws error if not authenticated
 * Use in Server Actions and API routes that require authentication
 */
export async function requireAuth(): Promise<{ session: Session; user: User }> {
  const session = await getSession();

  if (!session?.user) {
    throw new Error("Authentication required");
  }

  return { session, user: session.user };
}

/**
 * Get user with team information
 * Returns user data with team context for authorization
 */
export async function getUserWithTeam(): Promise<{
  user: User;
  teamId: string | null;
  teamRole: string | null;
} | null> {
  const session = await getSession();

  if (!session?.user) {
    return null;
  }

  // Fetch team information from database using Supabase client
  const { createAdminClient } = await import("@/lib/supabase/server");
  const supabase = createAdminClient();

  try {
    // Fetch all team memberships for the user
    const { data: teamMembers, error } = await supabase
      .from("team_members")
      .select("team_id, role")
      .eq("user_id", session.user.id)
      .order("joined_at", { ascending: true }); // Oldest team first

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found" - that's okay
      throw error;
    }

    // If user has no teams, return null
    if (!teamMembers || teamMembers.length === 0) {
      return {
        user: session.user,
        teamId: null,
        teamRole: null,
      };
    }

    // If user has multiple teams, select the one with the highest role
    let selectedTeam = teamMembers[0];
    if (teamMembers.length > 1) {
      const highestRole = getHighestRole(
        teamMembers.map((tm) => tm.role as TeamRole),
      );
      selectedTeam =
        teamMembers.find((tm) => tm.role === highestRole) || teamMembers[0];
    }

    return {
      user: session.user,
      teamId: selectedTeam.team_id,
      teamRole: selectedTeam.role,
    };
  } catch (error) {
    console.error("[Auth] Failed to fetch team info:", error);
    return {
      user: session.user,
      teamId: null,
      teamRole: null,
    };
  }
}

/**
 * Check if user has access to a team resource
 * Used for team-based authorization
 */
export async function checkTeamAccess(teamId: string): Promise<boolean> {
  const userWithTeam = await getUserWithTeam();

  if (!userWithTeam) {
    return false;
  }

  return userWithTeam.teamId === teamId;
}

/**
 * Create an anonymous session
 * Used when users start creating without signing up
 */
export async function createAnonymousSession(): Promise<Session | null> {
  try {
    const headersList = await headers();
    // Use the anonymous plugin's sign-in method
    const result = await auth.api.signInAnonymous({
      headers: headersList,
    });

    if (!result) {
      return null;
    }

    // Return the session data
    return {
      session: {
        token: result.token,
        userId: result.user.id,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt,
      },
      user: result.user,
    } as unknown as Session;
  } catch (error) {
    console.error("[Auth] Failed to create anonymous session:", error);
    return null;
  }
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<{ success: boolean; error?: string }> {
  try {
    const headersList = await headers();
    const result = await auth.api.signOut({
      headers: headersList,
    });

    return { success: result.success };
  } catch (error) {
    console.error("[Auth] Failed to sign out:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to sign out",
    };
  }
}
