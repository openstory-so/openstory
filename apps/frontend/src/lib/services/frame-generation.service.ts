/**
 * Frame Generation Service Layer
 *
 * Handles AI-powered frame generation orchestration including script analysis,
 * frame description generation, and async job queueing. Separated from FrameService
 * to keep concerns focused.
 *
 * @module lib/services/frame-generation.service
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeScriptForFrames } from "@/lib/ai/script-analyzer";
import { ValidationError } from "@/lib/errors";
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import { LoggerService } from "@/lib/services/logger.service";
import { createServerClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/types/database";
import { type FrameService, frameService } from "./frame.service";
import { FrameGenerationJobService } from "./frame-generation-job/frame-generation-job.service";

export interface GenerateFramesParams {
  sequenceId: string;
  userId: string;
  options?: {
    framesPerScene?: number;
    generateThumbnails?: boolean;
    generateDescriptions?: boolean;
    aiProvider?: "openai" | "anthropic" | "openrouter";
    regenerateAll?: boolean;
  };
}

export interface FrameGenerationResult {
  frameCount: number;
  jobId?: string;
  message: string;
}

/**
 * Frame Generation Service Class
 *
 * Orchestrates the AI-powered frame generation process.
 * Assumes caller has verified authentication and authorization.
 */
export class FrameGenerationService {
  private frameService: FrameService;

  constructor(
    private supabase: SupabaseClient<Database> = createServerClient(),
    frameServiceInstance?: FrameService,
  ) {
    this.frameService = frameServiceInstance ?? frameService;
  }

  /**
   * Generate frames for a sequence using AI
   *
   * Phase 1: Quick frame creation (synchronous)
   * Phase 2: Async image generation (queued jobs)
   *
   * @param params - Generation parameters
   * @throws {ValidationError} If sequence not found or invalid
   * @throws {Error} If generation fails
   * @returns Generation result with frame count and job ID
   */
  async generateFrames(
    params: GenerateFramesParams,
  ): Promise<FrameGenerationResult> {
    // Verify sequence exists and get all required data
    const loggerService = new LoggerService("FrameGenerationService");
    const { data: sequence, error: sequenceError } = await this.supabase
      .from("sequences")
      .select("*, styles(*)")
      .eq("id", params.sequenceId)
      .single();

    if (sequenceError || !sequence) {
      loggerService.logError("Sequence not found");
      return {
        frameCount: 0,
        message: "Sequence not found",
      };
    }

    if (!sequence.script) {
      loggerService.logError("Sequence has no script");
      return {
        frameCount: 0,
        message: "Sequence has no script",
      };
    }

    if (!sequence.style_id) {
      loggerService.logError("Sequence has no style selected");
      return {
        frameCount: 0,
        message: "Sequence has no style selected",
      };
    }

    // Set sequence status to processing
    await this.updateSequenceStatus(params.sequenceId, "processing", {
      frameGeneration: {
        status: "processing",
        startedAt: new Date().toISOString(),
        expectedFrameCount: null,
        completedFrameCount: 0,
        options: params.options,
        error: null,
        failedAt: null,
      },
    });

    // Check if the sequence already has frames
    const { data: frames, error: framesError } = await this.supabase
      .from("frames")
      .select("*")
      .eq("sequence_id", params.sequenceId);

    if (framesError) {
      loggerService.logError("Failed to get frames");
      return {
        frameCount: 0,
        message: "Failed to get frames",
      };
    }

    // Delete existing frames
    if (frames && frames.length > 0) {
      await Promise.all(
        frames.map((frame) => {
          return this.frameService.deleteFrame(frame.id);
        }),
      );
    }

    // Step 1: Analyze script to determine frame boundaries
    const scriptAnalysis = await analyzeScriptForFrames(
      sequence.script,
      params.options?.aiProvider,
    );
    const frameCount = scriptAnalysis.scenes.length;

    if (!scriptAnalysis?.scenes || frameCount === 0) {
      loggerService.logError("Failed to analyze script or no scenes found");
      return {
        frameCount: 0,
        message: "Failed to analyze script or no scenes found",
      };
    }

    const frameGenerationService = new FrameGenerationJobService();

    // Step 2: Process each scene and generate frames with async jobs
    scriptAnalysis.scenes.forEach(async (scene, index) => {
      await frameGenerationService.processScene({
        sequenceId: params.sequenceId,
        userId: params.userId,
        teamId: sequence.team_id,
        scene: {
          ...scene,
          orderIndex: index,
        },
        aiProvider: params.options?.aiProvider,
        generateThumbnails: params.options?.generateThumbnails,
      });
    });

    // Step 3: Update sequence metadata
    await this.updateSequenceStatus(params.sequenceId, "processing", {
      frameGeneration: {
        status: "generating_thumbnails",
        startedAt: new Date().toISOString(),
        expectedFrameCount: frameCount,
        completedFrameCount: 0,
        options: params.options,
        error: null,
        failedAt: null,
        thumbnailsGenerating: true,
      },
    });

    return {
      frameCount: frameCount,
      message:
        params.options?.generateThumbnails !== false
          ? `Created ${frameCount} frames. Thumbnail generation is in progress.`
          : `Created ${frameCount} frames.`,
    };
  }

  /**
   * Update sequence status and metadata
   *
   * @param sequenceId - The sequence ID
   * @param status - The new status
   * @param metadata - Additional metadata to merge
   * @throws {Error} If database operation fails
   */
  private async updateSequenceStatus(
    sequenceId: string,
    status: "draft" | "processing" | "completed" | "failed" | "archived",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Get current metadata
    const { data: sequence } = await this.supabase
      .from("sequences")
      .select("metadata")
      .eq("id", sequenceId)
      .single();

    const currentMetadata =
      (sequence?.metadata as Record<string, unknown>) || {};

    const { error } = await this.supabase
      .from("sequences")
      .update({
        status,
        metadata: {
          ...currentMetadata,
          ...metadata,
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sequenceId);

    if (error) {
      throw new Error(`Failed to update sequence status: ${error.message}`);
    }
  }

  /**
   * Regenerate a single frame's thumbnail
   *
   * @param frameId - The frame ID
   * @param userId - The user ID
   * @param teamId - The team ID
   * @param options - Regeneration options
   * @throws {ValidationError} If frame not found
   * @throws {Error} If regeneration fails
   * @returns Job ID for async processing
   */
  async regenerateFrame(
    frameId: string,
    userId: string,
    teamId: string,
    options?: {
      model?: string;
      image_size?: string;
    },
  ): Promise<string> {
    const frame = await this.frameService.getFrame(frameId);

    if (!frame) {
      throw new ValidationError("Frame not found");
    }

    if (!frame.description) {
      throw new ValidationError("Frame has no description to regenerate from");
    }

    // Create job for image regeneration
    const jobManager = getJobManager();
    const qstashClient = getQStashClient();

    const job = await jobManager.createJob({
      type: "image",
      payload: {
        frameId,
        sequenceId: frame.sequence_id,
        prompt: frame.description,
        model: options?.model || "flux_krea_lora",
        image_size: options?.image_size || "landscape_16_9",
        num_images: 1,
      },
      userId,
      teamId,
    });

    // Queue the image generation job using the typed helper
    const payload = {
      jobId: job.id,
      type: "image" as const,
      userId,
      teamId,
      data: {
        frameId,
        sequenceId: frame.sequence_id,
        prompt: frame.description,
        model: options?.model || "flux_krea_lora",
        image_size: options?.image_size || "landscape_16_9",
        num_images: 1,
      },
    };

    await qstashClient.publishImageJob(payload, {
      deduplicationId: job.id,
    });

    return job.id;
  }
}

// Singleton instance
export const frameGenerationService = new FrameGenerationService();
