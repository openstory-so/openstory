/**
 * Frame routes
 * API endpoints for frame management
 */

import { type } from "arktype";
import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import {
  type CreateFrameInput,
  createFrameSchema,
  reorderFramesSchema,
  type UpdateFrameInput,
  updateFrameSchema,
} from "@/schemas/frames";
import { FrameService } from "@/services/frames";

/**
 * Frame routes plugin
 */
export const frameRoutes = new Elysia({ prefix: "/frames" })
  .use(requireAuth)

  // GET /frames?sequenceId=xxx - List frames for a sequence
  .get(
    "/",
    async (context) => {
      const { query, user } = context as any;
      const { sequenceId } = query;

      if (!sequenceId) {
        return {
          success: false,
          error: "sequenceId query parameter is required",
        };
      }

      const frames = await FrameService.listBySequence(sequenceId, user);

      return {
        success: true,
        data: frames,
      };
    },
    {
      query: t.Object({
        sequenceId: t.String(),
      }),
    },
  )

  // POST /frames - Create a new frame
  .post(
    "/",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createFrameSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateFrameInput;
      const frame = await FrameService.create(input, user);

      return {
        success: true,
        data: frame,
      };
    },
    {
      body: t.Object({
        sequenceId: t.String(),
        description: t.String(),
        orderIndex: t.Number(),
        thumbnailUrl: t.Optional(t.String()),
        videoUrl: t.Optional(t.String()),
        durationMs: t.Optional(t.Number()),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // GET /frames/:id - Get frame by ID
  .get("/:id", async (context) => {
    const { params, user } = context as any;
    const frame = await FrameService.getById(params.id, user);

    return {
      success: true,
      data: frame,
    };
  })

  // PUT /frames/:id - Update frame
  .put(
    "/:id",
    async (context) => {
      const { params, body, user } = context as any;

      // Validate with ArkType
      const validation = updateFrameSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as UpdateFrameInput;
      const frame = await FrameService.update(params.id, input, user);

      return {
        success: true,
        data: frame,
      };
    },
    {
      body: t.Object({
        description: t.Optional(t.String()),
        orderIndex: t.Optional(t.Number()),
        thumbnailUrl: t.Optional(t.Union([t.String(), t.Null()])),
        videoUrl: t.Optional(t.Union([t.String(), t.Null()])),
        durationMs: t.Optional(t.Union([t.Number(), t.Null()])),
        metadata: t.Optional(t.Any()),
      }),
    },
  )

  // DELETE /frames/:id - Delete frame
  .delete("/:id", async (context) => {
    const { params, user } = context as any;
    const result = await FrameService.delete(params.id, user);

    return {
      success: true,
      data: result,
    };
  })

  // POST /frames/reorder - Reorder frames in a sequence
  .post(
    "/reorder",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = reorderFramesSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const { sequenceId, frameIds } = body as any;

      if (!sequenceId) {
        return {
          success: false,
          error: "sequenceId is required",
        };
      }

      const result = await FrameService.reorder(sequenceId, { frameIds }, user);

      return {
        success: true,
        data: result,
      };
    },
    {
      body: t.Object({
        sequenceId: t.String(),
        frameIds: t.Array(t.String()),
      }),
    },
  );
