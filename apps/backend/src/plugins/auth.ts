/**
 * Authentication plugin for Elysia
 * Extracts session from cookies and adds user/session to context
 */

import { Elysia, type Context } from "elysia";
import { auth, type User } from "@/lib/auth/config";
import { AuthenticationError } from "./error";

/**
 * Extended context type with auth properties
 * Note: Elysia's type system doesn't automatically infer extended context from plugins,
 * so we need to manually type the context when accessing derived properties.
 */
export type AuthContext = Context & {
  user: User | null;
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  } | null;
};

/**
 * Auth plugin that adds session and user to request context
 * Does NOT require authentication - just extracts if present
 *
 * Uses BetterAuth's recommended pattern with request.headers
 * @see https://elysiajs.com/integrations/better-auth.html
 */
export const authPlugin = new Elysia({ name: "auth" }).derive(
  async ({ request }) => {
    try {
      // Get session from BetterAuth using request headers
      // BetterAuth automatically extracts cookies from headers
      const sessionData = await auth.api.getSession({
        headers: request.headers,
      });

      if (!sessionData) {
        return {
          user: null,
          session: null,
        };
      }

      return {
        user: sessionData.user as User,
        session: sessionData.session,
      };
    } catch (error) {
      console.error("[Auth Plugin] Error getting session:", error);
      return {
        user: null,
        session: null,
      };
    }
  }
);

/**
 * Require authentication guard
 * Throws AuthenticationError if user is not authenticated
 *
 * Note: We use `context as AuthContext` because Elysia's type system doesn't
 * automatically infer the extended context from the authPlugin.
 */
export const requireAuth = new Elysia({ name: "require-auth" })
  .use(authPlugin)
  .derive((context) => {
    const { user, session } = context as AuthContext;

    if (!user || !session) {
      throw new AuthenticationError("Authentication required");
    }

    return {
      user,
      session,
    };
  });

/**
 * Require authenticated (non-anonymous) user guard
 * Throws AuthenticationError if user is anonymous
 *
 * Note: We use `context as AuthContext` because Elysia's type system doesn't
 * automatically infer the extended context from the requireAuth plugin.
 */
export const requireAuthenticatedUser = new Elysia({
  name: "require-authenticated-user",
})
  .use(requireAuth)
  .derive((context) => {
    const { user } = context as AuthContext;

    if (user?.isAnonymous) {
      throw new AuthenticationError(
        "This action requires a registered account. Please sign up or log in."
      );
    }

    return { user };
  });

