import { createSessionAwareClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/database";

interface SessionResult {
  user: UserProfile;
  isAuthenticated: boolean;
  isAnonymous: boolean;
}

/**
 * Verify session and ensure user exists (creating anonymous user if needed)
 * This follows Next.js 15 SSR authentication patterns and uses Supabase native anonymous auth
 */
export async function verifySession(): Promise<SessionResult> {
  const supabase = await createSessionAwareClient();

  try {
    // Check for existing Supabase session first
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      console.error("Session error:", sessionError);
    }

    if (session?.user) {
      // We have a session - check if it's anonymous or authenticated
      const isAnonymous = session.user.is_anonymous || false;

      // Create enhanced user profile with metadata
      const userProfile: UserProfile = {
        ...session.user,
        full_name: session.user.user_metadata?.full_name || null,
        avatar_url: session.user.user_metadata?.avatar_url || null,
        onboarding_completed:
          session.user.user_metadata?.onboarding_completed || false,
      };

      return {
        user: userProfile,
        isAuthenticated: !isAnonymous,
        isAnonymous: isAnonymous,
      };
    }

    // No session exists - create anonymous user
    const { data, error } = await supabase.auth.signInAnonymously();

    if (error) {
      console.error("Anonymous sign-in error:", error);
      throw new Error("Failed to create anonymous session");
    }

    if (!data.user) {
      throw new Error("No user returned from anonymous sign-in");
    }

    // Create enhanced user profile for the new anonymous user
    const userProfile: UserProfile = {
      ...data.user,
      full_name: null,
      avatar_url: null,
      onboarding_completed: false,
    };

    return {
      user: userProfile,
      isAuthenticated: false,
      isAnonymous: true,
    };
  } catch (error) {
    console.error("Session verification error:", error);
    throw error;
  }
}

/**
 * Get current user ID for API routes
 * Returns the authenticated or anonymous user ID
 */
export async function getCurrentUserId(): Promise<string | null> {
  const supabase = await createSessionAwareClient();

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    return session?.user?.id || null;
  } catch (error) {
    console.error("Error getting current user ID:", error);
    return null;
  }
}
