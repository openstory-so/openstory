/**
 * Temporal activities
 * Actual work execution for workflows (AI generation, storage, database updates)
 */

import { Context } from "@temporalio/activity";
import { db } from "@/db";
import { jobs } from "@/db/schema/jobs";
import { frames } from "@/db/schema/sequences";
import { getFalService, getOpenRouterService } from "@/lib/ai";
import { uploadImageFromUrl, uploadVideoFromUrl } from "@/lib/storage/supabase";
import { eq } from "drizzle-orm";

/**
 * Activity: Update job status
 */
export async function updateJobStatus(params: {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  result?: Record<string, unknown>;
}): Promise<void> {
  const { jobId, status, error, result } = params;

  const updateData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };

  if (status === "running") {
    updateData.startedAt = new Date();
  }

  if (status === "completed" || status === "failed") {
    updateData.completedAt = new Date();
  }

  if (error) {
    updateData.error = error;
  }

  if (result) {
    updateData.result = result;
  }

  await db.update(jobs).set(updateData).where(eq(jobs.id, jobId));

  Context.current().log.info(`Job ${jobId} status updated to ${status}`);
}

/**
 * Activity: Generate image using Fal.ai
 */
export async function generateImage(params: {
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  negativePrompt?: string;
  numInferenceSteps?: number;
  guidanceScale?: number;
  seed?: number;
  loraUrl?: string;
  loraScale?: number;
  userId?: string;
  teamId?: string;
  jobId?: string;
}): Promise<{
  imageUrl: string;
  width: number;
  height: number;
  cost: number;
  latencyMs: number;
}> {
  const falService = getFalService();

  const result = await falService.generateImage(
    params.model as any,
    {
      prompt: params.prompt,
      image_size: {
        width: params.width || 1024,
        height: params.height || 1024,
      },
      negative_prompt: params.negativePrompt,
      num_inference_steps: params.numInferenceSteps,
      guidance_scale: params.guidanceScale,
      seed: params.seed,
      loras: params.loraUrl
        ? [{ path: params.loraUrl, scale: params.loraScale || 1 }]
        : undefined,
    },
    {
      userId: params.userId,
      teamId: params.teamId,
      jobId: params.jobId,
    }
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Image generation failed");
  }

  // Extract image URL from response
  const imageData = result.data as any;
  const imageUrl = imageData.images?.[0]?.url || imageData.image?.url;

  if (!imageUrl) {
    throw new Error("No image URL in response");
  }

  Context.current().log.info(`Image generated: ${imageUrl}`);

  return {
    imageUrl,
    width: imageData.images?.[0]?.width || params.width || 1024,
    height: imageData.images?.[0]?.height || params.height || 1024,
    cost: result.cost || 0,
    latencyMs: result.latencyMs || 0,
  };
}

/**
 * Activity: Generate video using Fal.ai
 */
export async function generateVideo(params: {
  model: string;
  imageUrl: string;
  prompt?: string;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  seed?: number;
  loraUrl?: string;
  loraScale?: number;
  userId?: string;
  teamId?: string;
  jobId?: string;
}): Promise<{
  videoUrl: string;
  duration: number;
  cost: number;
  latencyMs: number;
}> {
  const falService = getFalService();

  const result = await falService.generateVideo(
    params.model as any,
    {
      image_url: params.imageUrl,
      prompt: params.prompt,
      duration: params.duration || 2,
      fps: params.fps || 7,
      motion_bucket_id: params.motionBucket || 127,
      seed: params.seed,
      loras: params.loraUrl
        ? [{ path: params.loraUrl, scale: params.loraScale || 1 }]
        : undefined,
    },
    {
      userId: params.userId,
      teamId: params.teamId,
      jobId: params.jobId,
    }
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Video generation failed");
  }

  // Extract video URL from response
  const videoData = result.data as any;
  const videoUrl = videoData.video?.url || videoData.url;

  if (!videoUrl) {
    throw new Error("No video URL in response");
  }

  Context.current().log.info(`Video generated: ${videoUrl}`);

  return {
    videoUrl,
    duration: params.duration || 2,
    cost: result.cost || 0,
    latencyMs: result.latencyMs || 0,
  };
}

/**
 * Activity: Analyze script using OpenRouter
 */
export async function analyzeScript(params: {
  script: string;
  framesPerScene?: number;
  userId?: string;
  teamId?: string;
}): Promise<{
  scenes: Array<{
    sceneNumber: number;
    description: string;
    frames: Array<{
      frameNumber: number;
      description: string;
      visualElements: string[];
    }>;
  }>;
  cost: number;
  latencyMs: number;
}> {
  const openRouterService = getOpenRouterService();

  const result = await openRouterService.analyzeScript({
    script: params.script,
    framesPerScene: params.framesPerScene || 3,
  });

  if (!result.success || !result.data) {
    throw new Error(result.error || "Script analysis failed");
  }

  Context.current().log.info(
    `Script analyzed: ${result.data.scenes.length} scenes`
  );

  return {
    scenes: result.data.scenes,
    cost: result.cost || 0,
    latencyMs: result.latencyMs || 0,
  };
}

/**
 * Activity: Upload image to Supabase Storage
 */
export async function uploadImage(params: {
  imageUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
}): Promise<{ publicUrl: string }> {
  const result = await uploadImageFromUrl(params);

  if (!result.success || !result.url) {
    throw new Error(result.error || "Image upload failed");
  }

  Context.current().log.info(`Image uploaded: ${result.url}`);

  return { publicUrl: result.url };
}

/**
 * Activity: Upload video to Supabase Storage
 */
export async function uploadVideo(params: {
  videoUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
}): Promise<{ publicUrl: string }> {
  const result = await uploadVideoFromUrl(params);

  if (!result.success || !result.url) {
    throw new Error(result.error || "Video upload failed");
  }

  Context.current().log.info(`Video uploaded: ${result.url}`);

  return { publicUrl: result.url };
}

/**
 * Activity: Update frame with generated content
 */
export async function updateFrame(params: {
  frameId: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { frameId, thumbnailUrl, videoUrl, metadata } = params;

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (thumbnailUrl) {
    updateData.thumbnailUrl = thumbnailUrl;
  }

  if (videoUrl) {
    updateData.videoUrl = videoUrl;
  }

  if (metadata) {
    updateData.metadata = metadata;
  }

  await db.update(frames).set(updateData).where(eq(frames.id, frameId));

  Context.current().log.info(`Frame ${frameId} updated`);
}

