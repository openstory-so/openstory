/**
 * Authentication routes
 * BetterAuth API endpoints for Elysia
 */

import { Elysia } from "elysia";
import { auth } from "@/lib/auth/config";
import { authPlugin } from "@/plugins/auth";

/**
 * Auth routes plugin
 * Mounts BetterAuth handlers at /api/auth/*
 */
export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(authPlugin)
  // Mount all BetterAuth handlers
  .all("/*", async ({ request }) => {
    // Forward request to BetterAuth handler
    return await auth.handler(request);
  })
  // Get current session
  .get("/session", async (context) => {
    const { user, session } = context as any;

    if (!user || !session) {
      return {
        success: false,
        data: null,
      };
    }

    return {
      success: true,
      data: {
        user,
        session,
      },
    };
  });

