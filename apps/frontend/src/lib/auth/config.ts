/**
 * BetterAuth configuration for Velro
 * Replaces Supabase Auth with anonymous users and email/password login
 */

import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { anonymous } from "better-auth/plugins";
import { pgPool } from "@/lib/db/pool";
import { createAdminClient } from "@/lib/supabase/server";

// Environment validation
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
} as const;

// Validate environment variables
for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const auth = betterAuth({
  database: pgPool,
  secret: requiredEnvVars.BETTER_AUTH_SECRET,
  baseURL: requiredEnvVars.BETTER_AUTH_URL,

  // Session configuration optimized for anonymous users
  // SECURITY: Reduced from 1 year to 90 days to
  //  mitigate:
  // - Session fixation attacks
  // - Database bloat from long-lived anonymous sessions
  // - GDPR compliance concerns
  session: {
    expiresIn: 60 * 60 * 24 * 90, // 90 days (reasonable for anonymous work)
    updateAge: 60 * 60 * 24, // Update session daily
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5-minute cache
    },
  },

  // Email and password authentication
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      console.log("[BetterAuth] Sending password reset email", {
        email: user.email,
        url,
      });

      // Import dynamically to avoid issues during build
      const { sendPasswordResetEmail } = await import("@/lib/email/service");
      const result = await sendPasswordResetEmail(user.email, url);

      if (!result.success) {
        console.error("[BetterAuth] Failed to send reset email:", result.error);
        throw new Error("Failed to send password reset email");
      }

      console.log("[BetterAuth] Password reset email sent successfully");
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour (in seconds)
  },

  // Social providers
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      enabled: !!(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
    },
  },

  // Configure plugins
  plugins: [
    // Anonymous user support with account linking
    anonymous({
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        console.log("[BetterAuth] Linking anonymous account", {
          anonymousUserId: anonymousUser.user.id,
          newUserId: newUser.user.id,
        });

        // Transfer anonymous user data to authenticated account using Supabase client
        const supabase = createAdminClient();

        try {
          // Call the transactional migration function
          // All data transfer happens atomically - either all succeeds or all rolls back
          const { data, error: migrationError } = await supabase.rpc(
            "migrate_anonymous_user_data" as unknown as never,
            {
              p_anonymous_user_id: anonymousUser.user.id,
              p_new_user_id: newUser.user.id,
            } as never,
          );

          if (migrationError) {
            console.error(
              "[BetterAuth] Migration transaction failed:",
              migrationError,
            );
            throw new Error(
              `Failed to migrate user data - transaction rolled back: ${migrationError.message}`,
            );
          }

          // Type the migration result
          const result = data as {
            success: boolean;
            target_team_id: string;
            migration_type: "merge" | "transfer";
            sequences_transferred: number;
            styles_transferred: number;
            credits_merged: number;
          };

          // Log successful migration with details
          console.log("[BetterAuth] Successfully linked anonymous account", {
            migrationType: result.migration_type,
            targetTeamId: result.target_team_id,
            sequencesTransferred: result.sequences_transferred,
            stylesTransferred: result.styles_transferred,
            creditsMerged: result.credits_merged,
          });
        } catch (error) {
          console.error(
            "[BetterAuth] Failed to link anonymous account:",
            error,
          );
          throw error;
        }
      },
    }),

    // Next.js cookie integration (must be last)
    nextCookies(),
  ],

  // Custom user fields to match existing schema, This is BetterAuth user table.
  user: {
    additionalFields: {
      fullName: {
        type: "string",
        required: false,
      },
      avatarUrl: {
        type: "string",
        required: false,
      },
      onboardingCompleted: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
    },
  },

  // Advanced configuration
  advanced: {
    database: {
      // Generate user ID compatible with existing UUID format
      generateId: () => crypto.randomUUID(),
    },
  },
});

// Type inference for the auth instance with custom fields
export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user & {
  teamId?: string | null;
  teamRole?: string | null;
  teamName?: string | null;
  teamSlug?: string | null;
  isAnonymous?: boolean | null; // From BetterAuth anonymous plugin
};
