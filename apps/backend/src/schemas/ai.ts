/**
 * ArkType validation schemas for AI generation endpoints
 */

import { type } from "arktype";

/**
 * Generate image request
 */
export const generateImageSchema = type({
  model: "string",
  prompt: "string",
  "width?": "number",
  "height?": "number",
  "negativePrompt?": "string",
  "numInferenceSteps?": "number",
  "guidanceScale?": "number",
  "seed?": "number",
  "loraUrl?": "string",
  "loraScale?": "number",
});

export type GenerateImageInput = typeof generateImageSchema.infer;

/**
 * Generate video request
 */
export const generateVideoSchema = type({
  model: "string",
  imageUrl: "string",
  "prompt?": "string",
  "duration?": "number",
  "fps?": "number",
  "motionBucket?": "number",
  "seed?": "number",
  "loraUrl?": "string",
  "loraScale?": "number",
});

export type GenerateVideoInput = typeof generateVideoSchema.infer;

/**
 * Analyze script request
 */
export const analyzeScriptSchema = type({
  script: "string",
  "framesPerScene?": "number",
  "model?": "string",
});

export type AnalyzeScriptInput = typeof analyzeScriptSchema.infer;

/**
 * Generate frame description request
 */
export const generateFrameDescriptionSchema = type({
  sceneDescription: "string",
  frameNumber: "number",
  totalFrames: "number",
  "model?": "string",
});

export type GenerateFrameDescriptionInput =
  typeof generateFrameDescriptionSchema.infer;

/**
 * AI service health check response
 */
export const aiHealthResponseSchema = type({
  service: "string",
  healthy: "boolean",
  "latencyMs?": "number",
  "error?": "string",
});

export type AIHealthResponse = typeof aiHealthResponseSchema.infer;

/**
 * Usage stats request
 */
export const usageStatsQuerySchema = type({
  "teamId?": "string",
  "userId?": "string",
  "service?": "'fal'|'letzai'|'openrouter'",
  "startDate?": "Date",
  "endDate?": "Date",
});

export type UsageStatsQuery = typeof usageStatsQuerySchema.infer;
