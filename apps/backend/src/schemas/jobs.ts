/**
 * ArkType validation schemas for jobs endpoints
 */

import { type } from "arktype";

/**
 * Create frame generation job
 */
export const createFrameGenerationJobSchema = type({
  "frameId": "string",
  "sequenceId": "string",
  "teamId": "string",
  "model": "string",
  "prompt": "string",
  "width?": "number",
  "height?": "number",
  "negativePrompt?": "string<=1000",
  "numInferenceSteps?": "number",
  "guidanceScale?": "number",
  "seed?": "number",
  "loraUrl?": "string",
  "loraScale?": "number",
});

export type CreateFrameGenerationJobInput =
  typeof createFrameGenerationJobSchema.infer;

/**
 * Create motion generation job
 */
export const createMotionGenerationJobSchema = type({
  "frameId": "string",
  "sequenceId": "string",
  "teamId": "string",
  "model": "string",
  "imageUrl": "string",
  "prompt?": "string",
  "duration?": "number",
  "fps?": "number",
  "motionBucket?": "number",
  "seed?": "number",
  "loraUrl?": "string",
  "loraScale?": "number",
});

export type CreateMotionGenerationJobInput =
  typeof createMotionGenerationJobSchema.infer;

/**
 * Create script analysis job
 */
export const createScriptAnalysisJobSchema = type({
  "sequenceId": "string",
  "teamId": "string",
  "script": "string",
  "framesPerScene?": "number",
});

export type CreateScriptAnalysisJobInput =
  typeof createScriptAnalysisJobSchema.infer;

/**
 * List jobs query
 */
export const listJobsQuerySchema = type({
  "teamId": "string",
  "type?": "string",
  "status?": "string",
  "limit?": "number",
  "offset?": "number",
});

export type ListJobsQuery = typeof listJobsQuerySchema.infer;

