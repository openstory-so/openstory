/**
 * QStash webhook handler for frame motion generation jobs
 * Handles image-to-video generation using Fal.ai models
 */

import type { JobPayload } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import { withQStashVerification } from "@/lib/qstash/middleware";
import type { MotionGenerationPayload } from "@/lib/qstash/types";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import { BaseWebhookHandler, type JobProcessor } from "../base-handler";

/**
 * Frame motion generation processor
 */
const processMotionGeneration: JobProcessor = async (
  payload: JobPayload,
  _metadata,
): Promise<Record<string, unknown>> => {
  const jobManager = getJobManager();
  const supabase = createAdminClient();

  // Type assertion for motion generation payload
  const motionPayload = payload as MotionGenerationPayload;
  const { jobId, data } = motionPayload;

  // Get stored job for authorization
  const storedJob = await jobManager.getJob(jobId);

  if (!storedJob) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // Verify frame exists and get sequence info
  const { data: frame, error: frameError } = await supabase
    .from("frames")
    .select("*, sequences!inner(team_id, style_id, styles(config))")
    .eq("id", data.frameId)
    .single();

  if (frameError || !frame) {
    throw new Error(`Frame not found: ${data.frameId}`);
  }

  // Verify team authorization
  if (storedJob.team_id && frame.sequences.team_id !== storedJob.team_id) {
    console.error("[Motion Webhook] Team ID mismatch - unauthorized access", {
      jobTeamId: storedJob.team_id,
      frameTeamId: frame.sequences.team_id,
      jobId,
      frameId: data.frameId,
    });
    throw new Error("Unauthorized: Team ID mismatch");
  }

  // Import motion service dynamically to avoid circular dependencies
  const { generateMotionForFrame } = await import(
    "@/lib/services/motion.service"
  );
  const { uploadVideoToStorage } = await import(
    "@/lib/services/video-storage.service"
  );

  try {
    // Generate motion using Fal.ai
    const videoResult = await generateMotionForFrame({
      imageUrl: data.thumbnailUrl,
      prompt: data.prompt,
      model: data.model || "svd-lcm",
      duration: data.duration || 2,
      fps: data.fps || 7,
      motionBucket: data.motionBucket || 127,
      styleStack: frame.sequences.styles?.config as Json | undefined,
    });

    if (!videoResult.success || !videoResult.videoUrl) {
      throw new Error(videoResult.error || "Motion generation failed");
    }

    // Upload video to Supabase Storage
    const storageResult = await uploadVideoToStorage({
      videoUrl: videoResult.videoUrl,
      teamId: frame.sequences.team_id,
      sequenceId: data.sequenceId,
      frameId: data.frameId,
    });

    if (!storageResult.success || !storageResult.url) {
      throw new Error(storageResult.error || "Failed to upload video");
    }

    // Update frame with video URL
    const { error: updateError } = await supabase
      .from("frames")
      .update({
        video_url: storageResult.url,
        duration_ms: (data.duration || 2) * 1000, // Convert seconds to milliseconds
        metadata: {
          ...(frame.metadata as Record<string, unknown>),
          motionJobId: jobId,
          motionStatus: "completed",
          motionModel: data.model || "svd-lcm",
          motionGeneratedAt: new Date().toISOString(),
          motionMetadata: videoResult.metadata,
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.frameId);

    if (updateError) {
      throw new Error(`Failed to update frame: ${updateError.message}`);
    }

    // Return result for job tracking
    return {
      frameId: data.frameId,
      sequenceId: data.sequenceId,
      videoUrl: storageResult.url,
      duration: data.duration || 2,
      model: data.model || "svd-lcm",
      message: "Motion generated successfully",
    };
  } catch (error) {
    // Update frame metadata to indicate failure
    await supabase
      .from("frames")
      .update({
        metadata: {
          ...(frame.metadata as Record<string, unknown>),
          motionJobId: jobId,
          motionStatus: "failed",
          motionError: error instanceof Error ? error.message : "Unknown error",
          motionFailedAt: new Date().toISOString(),
        } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.frameId);

    throw error;
  }
};

// Create the webhook handler
const handler = new BaseWebhookHandler();

// Export the HTTP route handler
export const POST = withQStashVerification(async (request) =>
  handler.processWebhook(request, processMotionGeneration),
);
