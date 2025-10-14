/**
 * BetterAuth Server Actions
 * Handles authentication operations on the server side
 */

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createAnonymousSession,
  getSession,
  getUser,
  signOut,
} from "@/lib/auth/server";
import { createServerClient } from "@/lib/supabase/server";

// Validation schemas
const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(255).optional(),
  avatarUrl: z.string().optional(),
  onboardingCompleted: z.boolean().optional(),
});

interface AuthResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Get current user session and profile data
 */
export async function getCurrentUserSession(): Promise<AuthResponse> {
  try {
    const session = await getSession();

    if (!session?.user) {
      return {
        success: false,
        error: "No active session",
      };
    }

    return {
      success: true,
      data: {
        user: session.user,
        session: session.session,
        isAuthenticated: session.user.isAnonymous !== true,
        isAnonymous: session.user.isAnonymous === true,
      },
    };
  } catch (error) {
    console.error("[getCurrentUserSession] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get session",
    };
  }
}

/**
 * Create anonymous session for new users
 */
export async function createAnonymousSessionAction(): Promise<AuthResponse> {
  try {
    const session = await createAnonymousSession();

    if (!session) {
      return {
        success: false,
        error: "Failed to create anonymous session",
      };
    }

    // Ensure user has a record in our users table and a team
    const supabase = createServerClient();

    // Create user record if it doesn't exist
    const { error: userError } = await supabase.from("users").upsert({
      id: session.user.id,
      full_name: session.user.name || null,
    });

    if (userError) {
      console.error(
        "[createAnonymousSessionAction] User creation error:",
        userError,
      );
      // Return error instead of continuing with inconsistent state
      return {
        success: false,
        error: "Failed to initialize user account",
      };
    }

    return {
      success: true,
      data: {
        user: session.user,
        session: session.session,
        isAuthenticated: false,
        isAnonymous: true,
      },
    };
  } catch (error) {
    console.error("[createAnonymousSessionAction] Error:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to create session",
    };
  }
}

/**
 * Update user profile information
 */
export async function updateUserProfile(
  formData: FormData,
): Promise<AuthResponse> {
  try {
    const user = await getUser();

    if (!user) {
      return {
        success: false,
        error: "Authentication required",
      };
    }

    const fullName = formData.get("fullName") as string | undefined;
    const avatarUrl = formData.get("avatarUrl") as string | undefined;
    const onboardingCompleted = formData.get("onboardingCompleted") === "true";

    const validatedData = updateProfileSchema.parse({
      fullName,
      avatarUrl,
      onboardingCompleted,
    });

    // Update user in BetterAuth
    // Note: BetterAuth user updates would be handled through the auth API
    // For now, we'll update our users table directly
    const supabase = createServerClient();

    const { error } = await supabase
      .from("users")
      .update({
        full_name: validatedData.fullName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) {
      return {
        success: false,
        error: `Failed to update profile: ${error.message}`,
      };
    }

    revalidatePath("/profile");
    revalidatePath("/dashboard");

    return {
      success: true,
      data: { message: "Profile updated successfully" },
    };
  } catch (error) {
    console.error("[updateUserProfile] Error:", error);

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.issues[0]?.message || "Invalid input",
      };
    }

    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to update profile",
    };
  }
}

/**
 * Sign out current user
 */
export async function signOutAction(): Promise<AuthResponse> {
  try {
    const result = await signOut();

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to sign out",
      };
    }

    revalidatePath("/");

    return {
      success: true,
      data: { message: "Signed out successfully" },
    };
  } catch (error) {
    console.error("[signOutAction] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to sign out",
    };
  }
}
