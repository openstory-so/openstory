/**
 * ArkType validation schemas for frames
 * Replaces Zod schemas from Next.js frontend
 */

import { type } from "arktype";

/**
 * Create frame request
 */
export const createFrameSchema = type({
  sequenceId: "string",
  description: "string",
  orderIndex: "number",
  "thumbnailUrl?": "string",
  "videoUrl?": "string",
  "durationMs?": "number",
  "metadata?": "unknown",
});

export type CreateFrameInput = typeof createFrameSchema.infer;

/**
 * Update frame request
 */
export const updateFrameSchema = type({
  "description?": "string",
  "orderIndex?": "number",
  "thumbnailUrl?": "string|null",
  "videoUrl?": "string|null",
  "durationMs?": "number|null",
  "metadata?": "unknown",
});

export type UpdateFrameInput = typeof updateFrameSchema.infer;

/**
 * Reorder frames request
 */
export const reorderFramesSchema = type({
  frameIds: "string[]",
});

export type ReorderFramesInput = typeof reorderFramesSchema.infer;

/**
 * Generate frames request
 */
export const generateFramesSchema = type({
  "framesPerScene?": "number",
  "generateThumbnails?": "boolean",
  "generateDescriptions?": "boolean",
  "aiProvider?": "'openai'|'anthropic'|'openrouter'",
  "regenerateAll?": "boolean",
});

export type GenerateFramesInput = typeof generateFramesSchema.infer;

/**
 * Regenerate frame request
 */
export const regenerateFrameSchema = type({
  "regenerateDescription?": "boolean",
  "regenerateThumbnail?": "boolean",
});

export type RegenerateFrameInput = typeof regenerateFrameSchema.infer;

/**
 * Generate motion request
 */
export const generateMotionSchema = type({
  "model?": "'veo3'|'kling-video'|'minimax-hailuo'|'wan-pro'",
  "duration?": "number",
  "fps?": "number",
  "motionStrength?": "number",
});

export type GenerateMotionInput = typeof generateMotionSchema.infer;

/**
 * Frame response
 */
export const frameResponseSchema = type({
  id: "string",
  sequenceId: "string",
  description: "string",
  orderIndex: "number",
  thumbnailUrl: "string|null",
  videoUrl: "string|null",
  durationMs: "number",
  metadata: "unknown",
  createdAt: "Date",
  updatedAt: "Date",
});

export type FrameResponse = typeof frameResponseSchema.infer;
