/**
 * Style routes
 * API endpoints for Style Stack management
 */

import { type } from "arktype";
import { Elysia, t } from "elysia";
import { authPlugin, requireAuth } from "@/plugins/auth";
import {
  type CreateStyleInput,
  createStyleSchema,
  type UpdateStyleInput,
  updateStyleSchema,
} from "@/schemas/styles";
import { StyleService } from "@/services/styles";

/**
 * Style routes plugin
 */
export const styleRoutes = new Elysia({ prefix: "/styles" })
  // GET /styles/public - List public styles (no auth required)
  .use(authPlugin)
  .get("/public", async () => {
    const styles = await StyleService.listPublic();

    return {
      success: true,
      data: styles,
    };
  })

  // All other routes require authentication
  .use(requireAuth)

  // GET /styles?teamId=xxx - List styles for a team
  .get(
    "/",
    async (context) => {
      const { query, user } = context as any;
      const { teamId } = query;

      if (!teamId) {
        return {
          success: false,
          error: "teamId query parameter is required",
        };
      }

      const styles = await StyleService.listByTeam(teamId, user);

      return {
        success: true,
        data: styles,
      };
    },
    {
      query: t.Object({
        teamId: t.String(),
      }),
    },
  )

  // POST /styles - Create a new style
  .post(
    "/",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createStyleSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateStyleInput;
      const { teamId } = body as any;

      if (!teamId) {
        return {
          success: false,
          error: "teamId is required",
        };
      }

      const style = await StyleService.create(teamId, input, user);

      return {
        success: true,
        data: style,
      };
    },
    {
      body: t.Object({
        teamId: t.String(),
        name: t.String(),
        configJson: t.Any(),
        isPublic: t.Optional(t.Boolean()),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // GET /styles/:id - Get style by ID
  .get("/:id", async (context) => {
    const { params, user } = context as any;
    const style = await StyleService.getById(params.id, user);

    return {
      success: true,
      data: style,
    };
  })

  // PUT /styles/:id - Update style
  .put(
    "/:id",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = updateStyleSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as UpdateStyleInput;
      const style = await StyleService.update(params.id, input, user);

      return {
        success: true,
        data: style,
      };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        configJson: t.Optional(t.Any()),
        isPublic: t.Optional(t.Boolean()),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // DELETE /styles/:id - Delete style
  .delete("/:id", async (context) => {
    const { params, user } = context as any;
    const result = await StyleService.delete(params.id, user);

    return {
      success: true,
      data: result,
    };
  });
