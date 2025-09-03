"use server";

import type { User } from "@supabase/supabase-js";
import { createSessionAwareClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/database";

export interface UserResponse {
  success: boolean;
  data?: {
    user: UserProfile;
    isAuthenticated: boolean;
    isAnonymous: boolean;
  };
  error?: string;
}

/**
 * Get or create the current user
 * - Returns existing authenticated user if logged in
 * - Creates anonymous user if not authenticated
 * - Ensures user always has a team
 */
export async function getCurrentUser(): Promise<UserResponse> {
  try {
    const supabase = await createSessionAwareClient();

    // Get the authenticated user (verifies with Supabase Auth server)
    const {
      data: { user },
      error: sessionError,
    } = await supabase.auth.getUser();

    // Handle refresh token errors
    if (sessionError) {
      // Check if this is a refresh token error
      if (
        sessionError.message?.includes("refresh_token_not_found") ||
        sessionError.message?.includes("Invalid Refresh Token") ||
        sessionError.code === "refresh_token_not_found"
      ) {
        // Create a new anonymous session
        const { data, error: anonError } =
          await supabase.auth.signInAnonymously();

        if (anonError) {
          return {
            success: false,
            error: "Failed to create anonymous session",
          };
        }

        if (!data.user) {
          return {
            success: false,
            error: "No user returned from anonymous sign-in",
          };
        }

        // Create team and user records for anonymous user
        const result = await createUserWithTeam(supabase, data.user);
        if (!result.success) {
          return result;
        }

        // Return the new anonymous user
        const userProfile: UserProfile = {
          ...data.user,
          full_name: null,
          avatar_url: null,
          onboarding_completed: false,
        };

        return {
          success: true,
          data: {
            user: userProfile,
            isAuthenticated: false,
            isAnonymous: true,
          },
        };
      }

      // For other session errors, return a generic error
      return {
        success: false,
        error: sessionError.message || "Failed to get session",
      };
    }

    // If no authenticated user exists, create an anonymous user
    if (!user) {
      const { data, error: anonError } =
        await supabase.auth.signInAnonymously();

      if (anonError) {
        return {
          success: false,
          error: "Failed to create anonymous session",
        };
      }

      if (!data.user) {
        return {
          success: false,
          error: "No user returned from anonymous sign-in",
        };
      }

      // Create team and user records
      const result = await createUserWithTeam(supabase, data.user);
      if (!result.success) {
        return result;
      }

      // Return the new anonymous user
      const userProfile: UserProfile = {
        ...data.user,
        full_name: null,
        avatar_url: null,
        onboarding_completed: false,
      };

      return {
        success: true,
        data: {
          user: userProfile,
          isAuthenticated: false,
          isAnonymous: true,
        },
      };
    }

    // We have a valid authenticated user
    // Ensure they have a team
    const { data: teamMembership } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id)
      .eq("role", "owner")
      .single();

    if (!teamMembership) {
      // User exists but has no team - create one for them
      const result = await createUserWithTeam(supabase, user);
      if (!result.success) {
        return result;
      }
    }

    const userProfile: UserProfile = {
      ...user,
      full_name: user.user_metadata?.full_name || null,
      avatar_url: user.user_metadata?.avatar_url || null,
      onboarding_completed: user.user_metadata?.onboarding_completed || false,
    };

    const isAnonymous = user.is_anonymous === true;

    return {
      success: true,
      data: {
        user: userProfile,
        isAuthenticated: !isAnonymous,
        isAnonymous,
      },
    };
  } catch (error) {
    console.error("Error in getCurrentUser:", error);

    // Handle any auth errors specifically
    if (error instanceof Error) {
      if (
        error.message?.includes("refresh_token_not_found") ||
        error.message?.includes("Invalid Refresh Token")
      ) {
        // Try to create a new anonymous session
        try {
          const supabase = await createSessionAwareClient();
          const { data, error: anonError } =
            await supabase.auth.signInAnonymously();

          if (!anonError && data.user) {
            const result = await createUserWithTeam(supabase, data.user);
            if (result.success) {
              const userProfile: UserProfile = {
                ...data.user,
                full_name: null,
                avatar_url: null,
                onboarding_completed: false,
              };

              return {
                success: true,
                data: {
                  user: userProfile,
                  isAuthenticated: false,
                  isAnonymous: true,
                },
              };
            }
          }
        } catch {
          // Fall through to generic error
        }
      }
    }

    return {
      success: false,
      error: "Failed to get user data",
    };
  }
}

/**
 * Helper function to create user record and team
 */
async function createUserWithTeam(
  supabase: Awaited<ReturnType<typeof createSessionAwareClient>>,
  user: User,
): Promise<UserResponse> {
  const teamSlug = `user-${user.id.substring(0, 8)}-${Date.now()}`;

  // Create team
  const { data: team, error: teamError } = await supabase
    .from("teams")
    .insert({
      name: "My Team",
      slug: teamSlug,
    })
    .select()
    .single();

  if (teamError) {
    return {
      success: false,
      error: `Failed to create team: ${teamError.message}`,
    };
  }

  // Create user record if doesn't exist
  const { error: userInsertError } = await supabase.from("users").insert({
    id: user.id,
  });

  // Ignore duplicate key errors (user already exists)
  if (userInsertError && userInsertError.code !== "23505") {
    await supabase.from("teams").delete().eq("id", team.id);
    return {
      success: false,
      error: `Failed to create user record: ${userInsertError.message}`,
    };
  }

  // Add user as team owner
  const { error: memberError } = await supabase.from("team_members").insert({
    user_id: user.id,
    team_id: team.id,
    role: "owner",
  });

  if (memberError && memberError.code !== "23505") {
    // Ignore duplicate key errors
    await supabase.from("teams").delete().eq("id", team.id);
    return {
      success: false,
      error: `Failed to create team membership: ${memberError.message}`,
    };
  }

  return { success: true };
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSessionAwareClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to sign out",
    };
  }
}
