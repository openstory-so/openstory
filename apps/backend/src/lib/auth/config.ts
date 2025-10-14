/**
 * BetterAuth configuration for Velro Backend
 * Configured with Drizzle adapter for PostgreSQL
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous } from "better-auth/plugins";
import { db } from "@/db";
import { transferAnonymousUserData } from "./anonymous-migration";

// Environment validation
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "http://localhost:3030",
} as const;

// Validate environment variables
for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const auth = betterAuth({
  // Use Drizzle adapter for database operations
  database: drizzleAdapter(db, {
    provider: "pg",
  }),

  secret: requiredEnvVars.BETTER_AUTH_SECRET,
  baseURL: requiredEnvVars.BETTER_AUTH_URL,

  // Session configuration optimized for anonymous users
  // SECURITY: 90 days to mitigate:
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

      // TODO: Implement email service
      // For now, just log the reset URL
      console.log("[BetterAuth] Password reset URL:", url);

      // In production, send email via email service
      // const { sendPasswordResetEmail } = await import("@/lib/email/service");
      // const result = await sendPasswordResetEmail(user.email, url);
      // if (!result.success) {
      //   throw new Error("Failed to send password reset email");
      // }
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour (in seconds)
  },

  // Social providers (optional)
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

        try {
          // Transfer anonymous user data to authenticated account
          const result = await transferAnonymousUserData(
            anonymousUser.user.id,
            newUser.user.id
          );

          // Log successful migration with details
          console.log("[BetterAuth] Successfully linked anonymous account", {
            migrationType: result.migrationType,
            targetTeamId: result.targetTeamId,
            sequencesTransferred: result.sequencesTransferred,
            stylesTransferred: result.stylesTransferred,
          });
        } catch (error) {
          console.error(
            "[BetterAuth] Failed to link anonymous account:",
            error
          );
          throw error;
        }
      },
    }),
  ],

  // Custom user fields to match existing schema
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

