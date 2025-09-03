import {
  createAdminClient,
  createSessionAwareClient,
} from "@/lib/supabase/server";
import type {
  AnonymousSession,
  AnonymousSessionInsert,
  Json,
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
   * Legacy method - now uses native anonymous authentication
   * @deprecated Use createAnonymousUser() instead
   */
  async createAnonymousSession(
    initialData?: Record<string, unknown>,
  ): Promise<AnonymousSession> {
    // For backward compatibility, we'll still support the anonymous_sessions table
    // but the primary user creation should use Supabase native auth
    const sessionId = crypto.randomUUID();

    const sessionData: AnonymousSessionInsert = {
      id: sessionId,
      data: (initialData || {}) as Json,
    };

    const supabase = await this.getSupabase();
    const { data, error } = await supabase
      .from("anonymous_sessions")
      .insert(sessionData)
      .select()
      .single();

    if (error) {
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
      .update({ data: data as Json })
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

      // Get current session (should be anonymous)
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.user?.is_anonymous) {
        return {
          success: false,
          error: "No anonymous user session found",
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
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.user) {
        return null;
      }

      // Create enhanced user profile
      const userProfile: UserProfile = {
        ...session.user,
        full_name: session.user.user_metadata?.full_name || null,
        avatar_url: session.user.user_metadata?.avatar_url || null,
        onboarding_completed:
          session.user.user_metadata?.onboarding_completed || false,
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
