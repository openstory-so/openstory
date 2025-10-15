/**
 * Temporal workflows
 * Orchestration logic for async job processing
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

// Create activity proxies with timeouts
const {
  updateJobStatus,
  generateImage,
  generateVideo,
  analyzeScript,
  uploadImage,
  uploadVideo,
  updateFrame,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

/**
 * Frame generation workflow
 * Generates image for a frame and uploads to storage
 */
export async function frameGenerationWorkflow(params: {
  jobId: string;
  frameId: string;
  sequenceId: string;
  teamId: string;
  userId?: string;
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
}): Promise<{
  success: boolean;
  thumbnailUrl?: string;
  error?: string;
}> {
  try {
    // Update job status to running
    await updateJobStatus({
      jobId: params.jobId,
      status: "running",
    });

    // Generate image
    const imageResult = await generateImage({
      model: params.model,
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      negativePrompt: params.negativePrompt,
      numInferenceSteps: params.numInferenceSteps,
      guidanceScale: params.guidanceScale,
      seed: params.seed,
      loraUrl: params.loraUrl,
      loraScale: params.loraScale,
      userId: params.userId,
      teamId: params.teamId,
      jobId: params.jobId,
    });

    // Upload image to storage
    const uploadResult = await uploadImage({
      imageUrl: imageResult.imageUrl,
      teamId: params.teamId,
      sequenceId: params.sequenceId,
      frameId: params.frameId,
    });

    // Update frame with thumbnail URL
    await updateFrame({
      frameId: params.frameId,
      thumbnailUrl: uploadResult.publicUrl,
      metadata: {
        generatedAt: new Date().toISOString(),
        model: params.model,
        cost: imageResult.cost,
        latencyMs: imageResult.latencyMs,
      },
    });

    // Update job status to completed
    await updateJobStatus({
      jobId: params.jobId,
      status: "completed",
      result: {
        thumbnailUrl: uploadResult.publicUrl,
        cost: imageResult.cost,
        latencyMs: imageResult.latencyMs,
      },
    });

    return {
      success: true,
      thumbnailUrl: uploadResult.publicUrl,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Update job status to failed
    await updateJobStatus({
      jobId: params.jobId,
      status: "failed",
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Motion generation workflow
 * Generates video from frame image and uploads to storage
 */
export async function motionGenerationWorkflow(params: {
  jobId: string;
  frameId: string;
  sequenceId: string;
  teamId: string;
  userId?: string;
  model: string;
  imageUrl: string;
  prompt?: string;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  seed?: number;
  loraUrl?: string;
  loraScale?: number;
}): Promise<{
  success: boolean;
  videoUrl?: string;
  error?: string;
}> {
  try {
    // Update job status to running
    await updateJobStatus({
      jobId: params.jobId,
      status: "running",
    });

    // Generate video
    const videoResult = await generateVideo({
      model: params.model,
      imageUrl: params.imageUrl,
      prompt: params.prompt,
      duration: params.duration,
      fps: params.fps,
      motionBucket: params.motionBucket,
      seed: params.seed,
      loraUrl: params.loraUrl,
      loraScale: params.loraScale,
      userId: params.userId,
      teamId: params.teamId,
      jobId: params.jobId,
    });

    // Upload video to storage
    const uploadResult = await uploadVideo({
      videoUrl: videoResult.videoUrl,
      teamId: params.teamId,
      sequenceId: params.sequenceId,
      frameId: params.frameId,
    });

    // Update frame with video URL
    await updateFrame({
      frameId: params.frameId,
      videoUrl: uploadResult.publicUrl,
      metadata: {
        motionGeneratedAt: new Date().toISOString(),
        model: params.model,
        duration: videoResult.duration,
        cost: videoResult.cost,
        latencyMs: videoResult.latencyMs,
      },
    });

    // Update job status to completed
    await updateJobStatus({
      jobId: params.jobId,
      status: "completed",
      result: {
        videoUrl: uploadResult.publicUrl,
        duration: videoResult.duration,
        cost: videoResult.cost,
        latencyMs: videoResult.latencyMs,
      },
    });

    return {
      success: true,
      videoUrl: uploadResult.publicUrl,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Update job status to failed
    await updateJobStatus({
      jobId: params.jobId,
      status: "failed",
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Script analysis workflow
 * Analyzes script and creates frames
 */
export async function scriptAnalysisWorkflow(params: {
  jobId: string;
  sequenceId: string;
  teamId: string;
  userId?: string;
  script: string;
  framesPerScene?: number;
}): Promise<{
  success: boolean;
  scenes?: Array<{
    sceneNumber: number;
    description: string;
    frames: Array<{
      frameNumber: number;
      description: string;
      visualElements: string[];
    }>;
  }>;
  error?: string;
}> {
  try {
    // Update job status to running
    await updateJobStatus({
      jobId: params.jobId,
      status: "running",
    });

    // Analyze script
    const analysisResult = await analyzeScript({
      script: params.script,
      framesPerScene: params.framesPerScene,
      userId: params.userId,
      teamId: params.teamId,
    });

    // Update job status to completed
    await updateJobStatus({
      jobId: params.jobId,
      status: "completed",
      result: {
        scenes: analysisResult.scenes,
        cost: analysisResult.cost,
        latencyMs: analysisResult.latencyMs,
      },
    });

    return {
      success: true,
      scenes: analysisResult.scenes,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Update job status to failed
    await updateJobStatus({
      jobId: params.jobId,
      status: "failed",
      error: errorMessage,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}
