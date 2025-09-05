/**
 * QStash webhook handler for frame generation jobs
 *
 * NOTE: This webhook now delegates to generateFramesAction to avoid
 * code duplication. It's primarily used for async/background frame
 * generation triggered via QStash.
 */

import { generateFramesAction } from "@/app/actions/frames";
import type { JobPayload } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import { withQStashVerification } from "@/lib/qstash/middleware";
import type { FrameGenerationPayload } from "@/lib/qstash/types";
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

  // Call the server action to generate frames
  console.log("[Frames Webhook] Delegating to generateFramesAction");
  const result = await generateFramesAction({
    sequenceId: data.sequenceId,
    options: data.options,
  });

  if (!result.success) {
    throw new Error(result.error || "Frame generation failed");
  }

  // Return a simple result object for job tracking
  return {
    sequenceId: data.sequenceId,
    frameCount: result.frameCount || 0,
    jobId: result.jobId,
    message: result.message || "Frames generated successfully",
  };
};

// Create the webhook handler
const handler = new BaseWebhookHandler();

// Export the HTTP route handler
export const POST = withQStashVerification(async (request) =>
  handler.processWebhook(request, processFrameGeneration),
);
