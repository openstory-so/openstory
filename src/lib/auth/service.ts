import {
  createAdminClient,
  createSessionAwareClient,
} from "@/lib/supabase/server";
import type {
  AnonymousSession,
  AnonymousSessionInsert,
  AnonymousSessionUpdate,
  UserProfile,
} from "@/types/database";

export class AuthService {
  private async getSupabase() {
    return await createSessionAwareClient();
  }

  private adminClient = createAdminClient();

  /**
   * Create an anonymous user using Supabase's native anonymous authentication
   */
  async createAnonymousUser(): Promise<UserProfile> {
    const supabase = await this.getSupabase();

    const { data, error } = await supabase.auth.signInAnonymously();

    if (error) {
      throw new Error(`Failed to create anonymous user: ${error.message}`);
    }

    if (!data.user) {
      throw new Error("No user returned from anonymous sign-in");
    }

    // Create a team for this anonymous user (same as regular users)
    const teamSlug = `user-${data.user.id.substring(0, 8)}-${Date.now()}`;
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .insert({
        name: "My Team", // Consistent naming with regular users
        slug: teamSlug,
      })
      .select()
      .single();

    if (teamError) {
      throw new Error(
        `Failed to create team for anonymous user: ${teamError.message}`,
      );
    }

    // Create user record for anonymous user (needed for team_members FK)
    // No email needed - it's stored in auth.users
    const { error: userError } = await supabase.from("users").insert({
      id: data.user.id,
      // Email is in auth.users, we only store additional profile data here
    });

    if (userError && userError.code !== "23505") {
      // Ignore duplicate key errors
      // Clean up team if user creation fails
      await supabase.from("teams").delete().eq("id", team.id);
      throw new Error(`Failed to create user record: ${userError.message}`);
    }

    // Add anonymous user as owner of their team (same as regular users)
    const { error: memberError } = await supabase.from("team_members").insert({
      user_id: data.user.id,
      team_id: team.id,
      role: "owner",
    });

    if (memberError && memberError.code !== "23505") {
      // Ignore duplicate key errors
      // Clean up if team member creation fails
      await supabase.from("teams").delete().eq("id", team.id);
      await supabase.from("users").delete().eq("id", data.user.id);
      throw new Error(
        `Failed to create team membership: ${memberError.message}`,
      );
    }

    // Create enhanced user profile
    const userProfile: UserProfile = {
      ...data.user,
      full_name: null,
      avatar_url: null,
      onboarding_completed: false,
    };

    return userProfile;
  }

  /**
   * Get the current user's team ID
   * All users (anonymous and registered) have teams stored the same way
   */
  async getCurrentUserTeamId(): Promise<string | null> {
    const supabase = await this.getSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return null;
    }

    // All users have their team relationship in team_members table
    // Get the team where they are the owner
    const { data } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("user_id", user.id)
      .eq("role", "owner")
      .limit(1)
      .single();

    return data?.team_id || null;
  }

  /**
   * Legacy method - now uses native anonymous authentication
   * @deprecated Use createAnonymousUser() instead
   */
  async createAnonymousSession(
    initialData?: Record<string, unknown>,
  ): Promise<AnonymousSession> {
    // For backward compatibility, we'll still support the anonymous_sessions table
    // but the primary user creation should use Supabase native auth
    const sessionId = crypto.randomUUID();

    const supabase = await this.getSupabase();

    // Create a team for this session
    const teamSlug = `anon-session-${sessionId.substring(0, 8)}-${Date.now()}`;
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .insert({
        name: "Anonymous Team",
        slug: teamSlug,
      })
      .select()
      .single();

    if (teamError) {
      throw new Error(
        `Failed to create team for anonymous session: ${teamError.message}`,
      );
    }

    const sessionData: AnonymousSessionInsert = {
      id: sessionId,
      team_id: team.id,
      data: (initialData || {}) as AnonymousSessionInsert["data"],
    };

    const { data, error } = await supabase
      .from("anonymous_sessions")
      .insert(sessionData)
      .select()
      .single();

    if (error) {
      // Clean up team if session creation fails
      await supabase.from("teams").delete().eq("id", team.id);
      throw new Error(`Failed to create anonymous session: ${error.message}`);
    }

    return data;
  }

  /**
   * Get an anonymous session by ID
   */
  async getAnonymousSession(
    sessionId: string,
  ): Promise<AnonymousSession | null> {
    const supabase = await this.getSupabase();
    const { data, error } = await supabase
      .from("anonymous_sessions")
      .select("*")
      .eq("id", sessionId)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (error && error.code !== "PGRST116") {
      throw new Error(`Failed to get anonymous session: ${error.message}`);
    }

    return data || null;
  }

  /**
   * Update anonymous session data
   */
  async updateAnonymousSession(
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<AnonymousSession> {
    const supabase = await this.getSupabase();
    const { data: updatedSession, error } = await supabase
      .from("anonymous_sessions")
      .update({ data: data as AnonymousSessionUpdate["data"] })
      .eq("id", sessionId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update anonymous session: ${error.message}`);
    }

    return updatedSession;
  }

  /**
   * Send magic link to user's email - works with both anonymous and new users
   */
  async sendMagicLink(
    email: string,
    redirectTo?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = await this.getSupabase();
      const finalRedirectTo =
        redirectTo || `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`;

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: finalRedirectTo,
        },
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Link anonymous user identity with email authentication
   * This uses Supabase's linkIdentity to convert anonymous users to permanent users
   */
  async upgradeAnonymousUser(
    email: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = await this.getSupabase();

      // Get current user (should be anonymous)
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user?.is_anonymous) {
        return {
          success: false,
          error: "No anonymous user found",
        };
      }

      // Send OTP to link the identity
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false, // Don't create new user, link to existing anonymous user
        },
      });

      if (error) {
        return { success: false, error: error.message };
      }

      // The user already has their team and team membership from when they were created
      // Email is stored in auth.users, not in our users table

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Update user profile metadata (works for both anonymous and authenticated users)
   */
  async updateUserProfile(updates: {
    full_name?: string | null;
    avatar_url?: string | null;
    onboarding_completed?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = await this.getSupabase();

      const { error } = await supabase.auth.updateUser({
        data: {
          full_name: updates.full_name,
          avatar_url: updates.avatar_url,
          onboarding_completed: updates.onboarding_completed,
        },
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Get current session from Supabase
   */
  async getSession() {
    try {
      const supabase = await this.getSupabase();
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        throw new Error(`Failed to get session: ${error.message}`);
      }

      return data.session;
    } catch (error) {
      console.error("Session error:", error);
      return null;
    }
  }

  /**
   * Get user profile - now returns enhanced profile with auth.users data
   */
  async getUserProfile(): Promise<UserProfile | null> {
    try {
      const supabase = await this.getSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        return null;
      }

      // Create enhanced user profile
      const userProfile: UserProfile = {
        ...user,
        full_name: user.user_metadata?.full_name || null,
        avatar_url: user.user_metadata?.avatar_url || null,
        onboarding_completed: user.user_metadata?.onboarding_completed || false,
      };

      return userProfile;
    } catch (error) {
      console.error("Error getting user profile:", error);
      return null;
    }
  }

  /**
   * Sign out user (works for both anonymous and authenticated users)
   */
  async signOut(): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = await this.getSupabase();
      const { error } = await supabase.auth.signOut();

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Clean up expired anonymous sessions (utility method for backward compatibility)
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const { data, error } = await this.adminClient.rpc(
        "cleanup_expired_anonymous_sessions",
      );

      if (error) {
        // If the RPC doesn't exist, that's fine - we're moving away from manual session management
        if (error.code === "42883") {
          // function does not exist
          return 0;
        }
        throw new Error(`Failed to cleanup expired sessions: ${error.message}`);
      }

      return data || 0;
    } catch (error) {
      console.warn("Cleanup sessions failed (this may be expected):", error);
      return 0;
    }
  }
}
