/**
 * AI generation routes
 * API endpoints for AI image/video generation and script analysis
 */

import { Elysia, t } from "elysia";
import { requireAuth } from "@/plugins/auth";
import {
  getFalService,
  getLetzAIService,
  getOpenRouterService,
  FAL_IMAGE_MODELS,
} from "@/lib/ai";
import { type } from "arktype";
import {
  generateImageSchema,
  generateVideoSchema,
  analyzeScriptSchema,
  generateFrameDescriptionSchema,
  type GenerateImageInput,
  type GenerateVideoInput,
  type AnalyzeScriptInput,
  type GenerateFrameDescriptionInput,
} from "@/schemas/ai";

/**
 * AI routes plugin
 */
export const aiRoutes = new Elysia({ prefix: "/ai" })
  .use(requireAuth)

  // POST /ai/generate-image - Generate image using Fal.ai or LetzAI
  .post(
    "/generate-image",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = generateImageSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as GenerateImageInput;

      // Determine which service to use based on model
      const isFalModel = Object.values(FAL_IMAGE_MODELS).includes(
        input.model as any
      );

      if (isFalModel) {
        // Use Fal.ai service
        const falService = getFalService();
        const result = await falService.generateImage(
          input.model as any,
          {
            prompt: input.prompt,
            image_size: {
              width: input.width || 1024,
              height: input.height || 1024,
            },
            negative_prompt: input.negativePrompt,
            num_inference_steps: input.numInferenceSteps,
            guidance_scale: input.guidanceScale,
            seed: input.seed,
            loras: input.loraUrl
              ? [{ path: input.loraUrl, scale: input.loraScale || 1 }]
              : undefined,
          },
          {
            userId: user.id,
            teamId: body.teamId,
          }
        );

        return result;
      } else {
        // Use LetzAI service
        const letzaiService = getLetzAIService();
        const result = await letzaiService.generateImage(
          {
            prompt: input.prompt,
            width: input.width || 1600,
            height: input.height || 1600,
            quality: 5,
            creativity: 2,
            hasWatermark: false,
            systemVersion: 2,
            mode: "cinematic",
          },
          {
            userId: user.id,
            teamId: body.teamId,
          }
        );

        return result;
      }
    },
    {
      body: t.Object({
        teamId: t.Optional(t.String()),
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

  // POST /ai/generate-video - Generate video using Fal.ai
  .post(
    "/generate-video",
    async (context) => {
      const { body, user } = context as any;

      // Validate with ArkType
      const validation = generateVideoSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as GenerateVideoInput;

      // Use Fal.ai service
      const falService = getFalService();
      const result = await falService.generateVideo(
        input.model as any,
        {
          image_url: input.imageUrl,
          prompt: input.prompt,
          duration: input.duration || 2,
          fps: input.fps || 7,
          motion_bucket_id: input.motionBucket || 127,
          seed: input.seed,
          loras: input.loraUrl
            ? [{ path: input.loraUrl, scale: input.loraScale || 1 }]
            : undefined,
        },
        {
          userId: user.id,
          teamId: body.teamId,
        }
      );

      return result;
    },
    {
      body: t.Object({
        teamId: t.Optional(t.String()),
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

  // POST /ai/analyze-script - Analyze script and extract scenes/frames
  .post(
    "/analyze-script",
    async (context) => {
      const { body } = context as any;

      // Validate with ArkType
      const validation = analyzeScriptSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as AnalyzeScriptInput;

      // Use OpenRouter service
      const openRouterService = getOpenRouterService();
      const result = await openRouterService.analyzeScript({
        script: input.script,
        framesPerScene: input.framesPerScene || 3,
      });

      return result;
    },
    {
      body: t.Object({
        script: t.String(),
        framesPerScene: t.Optional(t.Number()),
        model: t.Optional(t.String()),
      }),
    }
  )

  // POST /ai/generate-frame-description - Generate frame description
  .post(
    "/generate-frame-description",
    async (context) => {
      const { body } = context as any;

      // Validate with ArkType
      const validation = generateFrameDescriptionSchema(body);

      if (validation instanceof type.errors) {
        return {
          success: false,
          error: "Validation failed",
          details: validation.toString(),
        };
      }

      const input = validation as GenerateFrameDescriptionInput;

      // Use OpenRouter service
      const openRouterService = getOpenRouterService();
      const result = await openRouterService.generateFrameDescription({
        sceneDescription: input.sceneDescription,
        frameNumber: input.frameNumber,
        totalFrames: input.totalFrames,
      });

      return result;
    },
    {
      body: t.Object({
        sceneDescription: t.String(),
        frameNumber: t.Number(),
        totalFrames: t.Number(),
        model: t.Optional(t.String()),
      }),
    }
  )

  // GET /ai/health - Check AI services health
  .get("/health", async () => {
    const falService = getFalService();
    const letzaiService = getLetzAIService();
    const openRouterService = getOpenRouterService();

    const [falHealth, letzaiHealth, openRouterHealth] = await Promise.all([
      falService.checkHealth(),
      letzaiService.checkHealth(),
      openRouterService.checkHealth(),
    ]);

    return {
      success: true,
      data: {
        fal: falHealth,
        letzai: letzaiHealth,
        openrouter: openRouterHealth,
      },
    };
  })

  // GET /ai/usage - Get AI usage statistics
  .get(
    "/usage",
    async (context) => {
      const { query, user } = context as any;
      const { teamId, service } = query;

      if (service === "fal" || !service) {
        const falService = getFalService();
        const stats = await falService.getUsageStats({
          teamId,
          userId: user.id,
        });

        return {
          success: true,
          data: {
            service: "fal",
            ...stats,
          },
        };
      }

      if (service === "letzai") {
        const letzaiService = getLetzAIService();
        const stats = await letzaiService.getUsageStats({
          teamId,
          userId: user.id,
        });

        return {
          success: true,
          data: {
            service: "letzai",
            ...stats,
          },
        };
      }

      return {
        success: false,
        error: "Invalid service specified",
      };
    },
    {
      query: t.Object({
        teamId: t.Optional(t.String()),
        service: t.Optional(t.String()),
      }),
    }
  );

