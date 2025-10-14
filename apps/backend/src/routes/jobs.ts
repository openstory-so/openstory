/**
 * Jobs routes
 * API endpoints for async job management via Temporal
 */

import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import { JobsService } from "@/services/jobs";
import {
  createFrameGenerationJobSchema,
  createMotionGenerationJobSchema,
  createScriptAnalysisJobSchema,
  listJobsQuerySchema,
  type CreateFrameGenerationJobInput,
  type CreateMotionGenerationJobInput,
  type CreateScriptAnalysisJobInput,
  type ListJobsQuery,
} from "@/schemas/jobs";
import { type } from "arktype";

/**
 * Jobs routes plugin
 */
export const jobsRoutes = new Elysia({ prefix: "/jobs" })
  .use(requireAuth)

  // POST /jobs/frame-generation - Create frame generation job
  .post(
    "/frame-generation",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createFrameGenerationJobSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateFrameGenerationJobInput;

      const job = await JobsService.createFrameGenerationJob(input, user);

      return {
        success: true,
        data: job,
      };
    },
    {
      body: t.Object({
        frameId: t.String(),
        sequenceId: t.String(),
        teamId: t.String(),
        model: t.String(),
        prompt: t.String(),
        width: t.Optional(t.Number()),
        height: t.Optional(t.Number()),
        negativePrompt: t.Optional(t.String()),
        numInferenceSteps: t.Optional(t.Number()),
        guidanceScale: t.Optional(t.Number()),
        seed: t.Optional(t.Number()),
        loraUrl: t.Optional(t.String()),
        loraScale: t.Optional(t.Number()),
      }),
    }
  )

  // POST /jobs/motion-generation - Create motion generation job
  .post(
    "/motion-generation",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createMotionGenerationJobSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateMotionGenerationJobInput;

      const job = await JobsService.createMotionGenerationJob(input, user);

      return {
        success: true,
        data: job,
      };
    },
    {
      body: t.Object({
        frameId: t.String(),
        sequenceId: t.String(),
        teamId: t.String(),
        model: t.String(),
        imageUrl: t.String(),
        prompt: t.Optional(t.String()),
        duration: t.Optional(t.Number()),
        fps: t.Optional(t.Number()),
        motionBucket: t.Optional(t.Number()),
        seed: t.Optional(t.Number()),
        loraUrl: t.Optional(t.String()),
        loraScale: t.Optional(t.Number()),
      }),
    }
  )

  // POST /jobs/script-analysis - Create script analysis job
  .post(
    "/script-analysis",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = createScriptAnalysisJobSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as CreateScriptAnalysisJobInput;

      const job = await JobsService.createScriptAnalysisJob(input, user);

      return {
        success: true,
        data: job,
      };
    },
    {
      body: t.Object({
        sequenceId: t.String(),
        teamId: t.String(),
        script: t.String(),
        framesPerScene: t.Optional(t.Number()),
      }),
    }
  )

  // GET /jobs/:id - Get job by ID
  .get(
    "/:id",
    async (context) => {
      const { params, user } = context as any;
      const job = await JobsService.getJob(params.id, user);

      return {
        success: true,
        data: job,
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // GET /jobs - List jobs for a team
  .get(
    "/",
    async (context) => {
      const { query, user } = context as any;

      // Validate with ArkType
      const validation = listJobsQuerySchema(query);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as ListJobsQuery;

      const jobsList = await JobsService.listJobs(input, user);

      return {
        success: true,
        data: jobsList,
      };
    },
    {
      query: t.Object({
        teamId: t.String(),
        type: t.Optional(t.String()),
        status: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
        offset: t.Optional(t.Number()),
      }),
    }
  )

  // DELETE /jobs/:id - Cancel job
  .delete(
    "/:id",
    async (context) => {
      const { params, user } = context as any;
      const result = await JobsService.cancelJob(params.id, user);

      return result;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );

