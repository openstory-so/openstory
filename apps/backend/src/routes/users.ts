/**
 * User routes
 * API endpoints for user profile management
 */

import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import { UserService } from "@/services/users";

/**
 * User routes plugin
 */
export const userRoutes = new Elysia({ prefix: "/users" })
  .use(requireAuth)

  // GET /users/me - Get current user profile
  .get("/me", async (context) => {
    const { user } = context as any;
    const profile = await UserService.getCurrentUser(user);

    return {
      success: true,
      data: profile,
    };
  })

  // PUT /users/me - Update current user profile
  .put(
    "/me",
    async (context) => {
      const { body, user } = context as any;
      const updated = await UserService.update(user.id, body, user);

      return {
        success: true,
        data: updated,
      };
    },
    {
      body: t.Object({
        fullName: t.Optional(t.String()),
        avatarUrl: t.Optional(t.Union([t.String(), t.Null()])),
        onboardingCompleted: t.Optional(t.Boolean()),
      }),
    }
  )

  // GET /users/:id - Get user by ID
  .get("/:id", async (context) => {
    const { params, user } = context as any;
    const profile = await UserService.getById(params.id, user);

    return {
      success: true,
      data: profile,
    };
  });

