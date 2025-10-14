/**
 * Type definitions for QStash jobs and payloads
 */

import type { Json } from "@/types/database";

// Extend job types to include frame generation and motion
export const JobType = {
  IMAGE: "image",
  VIDEO: "video",
  SCRIPT: "script",
  FRAME_GENERATION: "frame_generation",
  MOTION: "motion",
} as const;

export type JobTypeType = (typeof JobType)[keyof typeof JobType];

// Job status enum matching database
export const JobStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type JobStatusType = (typeof JobStatus)[keyof typeof JobStatus];

// Base job payload interface
export interface BaseJobPayload {
  jobId: string;
  type: JobTypeType;
  // userId and teamId are stored in the jobs table for security
  // They should not be included in QStash payloads
  userId?: string;
  teamId?: string;
}

// Script analysis payload
export interface ScriptAnalysisPayload extends BaseJobPayload {
  type: "script";
  data: {
    sequenceId: string;
    script: string;
    style?: Json;
  };
}

// Image generation payload
export interface ImageGenerationPayload extends BaseJobPayload {
  type: "image";
  data: {
    prompt: string;
    style?: Json;
    model?: string;
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
}

// Video generation payload
export interface VideoGenerationPayload extends BaseJobPayload {
  type: "video";
  data: {
    imageUrl: string;
    prompt?: string;
    duration?: number;
    model?: string;
  };
}

// Frame generation payload - simplified to only require sequenceId
export interface FrameGenerationPayload extends BaseJobPayload {
  type: "frame_generation";
  data: {
    sequenceId: string;
    options?: {
      framesPerScene?: number; // Default: 3-7
      generateThumbnails?: boolean;
      generateDescriptions?: boolean;
      aiProvider?: "openai" | "anthropic" | "openrouter";
      regenerateAll?: boolean; // Default: true - whether to delete existing frames
    };
  };
}

// Motion generation payload for image-to-video
export interface MotionGenerationPayload extends BaseJobPayload {
  type: "motion";
  data: {
    frameId: string;
    sequenceId: string;
    thumbnailUrl: string;
    prompt?: string;
    model?: "svd-lcm" | "stable-video" | "animatediff"; // Model strategy
    duration?: number; // Duration in seconds
    fps?: number; // Frames per second
    motionBucket?: number; // Motion intensity (1-255)
  };
}

// Union type for all job payloads
export type JobPayload =
  | ScriptAnalysisPayload
  | ImageGenerationPayload
  | VideoGenerationPayload
  | FrameGenerationPayload
  | MotionGenerationPayload;

// Frame generation result
export interface FrameGenerationResult {
  frames: Array<{
    description: string;
    orderIndex: number;
    durationMs: number;
    metadata: {
      scene: number;
      shotType?: string;
      cameraAngle?: string;
      characters?: string[];
      settings?: string[];
      mood?: string;
      generationPrompt?: string;
    };
  }>;
  totalDuration: number;
  frameCount: number;
}

// QStash webhook payload
export interface QStashWebhookPayload<T = JobPayload> {
  body: T;
  headers: Record<string, string>;
  meta: {
    messageId: string;
    attempts: number;
    createdAt: number;
  };
}
