/**
 * QStash webhook handler for frame generation jobs
 *
 * NOTE: This webhook calls the frame generation service directly,
 * using the userId from the job record for authorization tracking.
 * It's primarily used for async/background frame generation triggered via QStash.
 */

import type { JobPayload } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import { withQStashVerification } from "@/lib/qstash/middleware";
import type { FrameGenerationPayload } from "@/lib/qstash/types";
import { frameGenerationService } from "@/lib/services/frame-generation.service";
import { createAdminClient } from "@/lib/supabase/server";
import { BaseWebhookHandler, type JobProcessor } from "../base-handler";

/**
 * Frame generation processor
 * Delegates to the server action to avoid code duplication
 */
const processFrameGeneration: JobProcessor = async (
  payload: JobPayload,
  metadata,
): Promise<Record<string, unknown>> => {
  const jobManager = getJobManager();
  const supabase = createAdminClient();

  // Type assertion for frame generation payload
  const framePayload = payload as FrameGenerationPayload;
  const { jobId, data } = framePayload;

  console.log("[Frames Webhook] Processing job:", {
    jobId,
    sequenceId: data.sequenceId,
    options: data.options,
    messageId: metadata.messageId,
    retryCount: metadata.retryCount,
  });

  // Get stored job for authorization
  const storedJob = await jobManager.getJob(jobId);

  if (!storedJob) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // Verify sequence exists and team authorization
  const { data: sequence, error: sequenceError } = await supabase
    .from("sequences")
    .select("team_id")
    .eq("id", data.sequenceId)
    .single();

  if (sequenceError || !sequence) {
    throw new Error(`Sequence not found: ${data.sequenceId}`);
  }

  // Verify team authorization
  if (storedJob.team_id && sequence.team_id !== storedJob.team_id) {
    console.error("[Frames Webhook] Team ID mismatch - unauthorized access", {
      jobTeamId: storedJob.team_id,
      sequenceTeamId: sequence.team_id,
      jobId,
      sequenceId: data.sequenceId,
    });
    throw new Error("Unauthorized: Team ID mismatch");
  }

  // Verify job has a user_id (required for frame generation)
  if (!storedJob.user_id) {
    throw new Error("Job missing user_id - cannot process frame generation");
  }

  // Call the frame generation service directly
  // Use the userId from the job record (who created the job)
  console.log("[Frames Webhook] Calling frameGenerationService.generateFrames");
  const result = await frameGenerationService.generateFrames({
    sequenceId: data.sequenceId,
    userId: storedJob.user_id, // Use job's user_id for tracking
    options: data.options,
  });

  // Return a simple result object for job tracking
  return {
    sequenceId: data.sequenceId,
    frameCount: result.frameCount,
    jobId: result.jobId,
    message: result.message,
  };
};

// Create the webhook handler
const handler = new BaseWebhookHandler();

// Export the HTTP route handler
export const POST = withQStashVerification(async (request) =>
  handler.processWebhook(request, processFrameGeneration),
);
