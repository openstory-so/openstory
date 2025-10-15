/**
 * Sequence routes
 * API endpoints for sequence management
 */

import { type } from "arktype";
import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import {
  type CreateSequenceInput,
  createSequenceSchema,
  type UpdateSequenceInput,
  updateSequenceSchema,
} from "@/schemas/sequences";
import { SequenceService } from "@/services/sequences";

/**
 * Sequence routes plugin
 */
export const sequenceRoutes = new Elysia({ prefix: "/sequences" })
  .use(requireAuth)

  // GET /sequences?teamId=xxx - List sequences for a team
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

      const sequences = await SequenceService.listByTeam(teamId, user);

      return {
        success: true,
        data: sequences,
      };
    },
    {
      query: t.Object({
        teamId: t.String(),
      }),
    },
  )

  // POST /sequences - Create a new sequence
  .post(
    "/",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createSequenceSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateSequenceInput;
      const { teamId } = body as any;

      if (!teamId) {
        return {
          success: false,
          error: "teamId is required",
        };
      }

      const sequence = await SequenceService.create(teamId, input, user);

      return {
        success: true,
        data: sequence,
      };
    },
    {
      body: t.Object({
        teamId: t.String(),
        title: t.String(),
        script: t.Optional(t.String()),
        styleId: t.Optional(t.String()),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // GET /sequences/:id - Get sequence by ID
  .get("/:id", async (context) => {
    const { params, user } = context as any;
    const sequence = await SequenceService.getById(params.id, user);

    return {
      success: true,
      data: sequence,
    };
  })

  // PUT /sequences/:id - Update sequence
  .put(
    "/:id",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = updateSequenceSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as UpdateSequenceInput;
      const sequence = await SequenceService.update(params.id, input, user);

      return {
        success: true,
        data: sequence,
      };
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        script: t.Optional(t.String()),
        status: t.Optional(t.String()),
        styleId: t.Optional(t.Union([t.String(), t.Null()])),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // DELETE /sequences/:id - Delete sequence
  .delete("/:id", async (context) => {
    const { params, user } = context as any;
    const result = await SequenceService.delete(params.id, user);

    return {
      success: true,
      data: result,
    };
  });
