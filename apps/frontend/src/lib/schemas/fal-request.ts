/**
 * Zod schemas for Fal.ai request validation
 */

import { z } from "zod";

// Fal request status enum schema
export const falRequestStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
]);

// Base Fal request schema
export const falRequestSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  team_id: z.string().uuid().nullable(),
  user_id: z.string().uuid().nullable(),
  model: z.string().min(1).max(255),
  request_payload: z.record(z.string(), z.unknown()).default({}),
  response_data: z.record(z.string(), z.unknown()).nullable(),
  cost_credits: z.number().min(0).nullable(),
  latency_ms: z.number().int().min(0).nullable(),
  status: falRequestStatusSchema.default("pending"),
  error: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Insert schema (for creating new records)
export const falRequestInsertSchema = falRequestSchema
  .omit({
    id: true,
    created_at: true,
    updated_at: true,
  })
  .partial({
    job_id: true,
    team_id: true,
    user_id: true,
    response_data: true,
    cost_credits: true,
    latency_ms: true,
    error: true,
  });

// Update schema (for updating existing records)
export const falRequestUpdateSchema = falRequestSchema
  .omit({
    id: true,
    created_at: true,
  })
  .partial();

// API request schemas for Fal service
export const falImageGenerationRequestSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1).max(2000),
  image_size: z
    .enum([
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
    ])
    .optional(),
  num_images: z.number().int().min(1).max(4).optional(),
  enable_safety_checker: z.boolean().optional(),
  seed: z.number().int().min(0).optional(),
  userId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
});

export const falVideoGenerationRequestSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1).max(2000).optional(),
  image_url: z.string().url().optional(),
  duration: z.number().min(1).max(10).optional(),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional(),
  enable_audio: z.boolean().optional(),
  seed: z.number().int().min(0).optional(),
  userId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
});

// Usage statistics request schema
export const falUsageStatsRequestSchema = z.object({
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(["day", "week", "month", "year"]).default("month"),
  includeBreakdown: z.boolean().default(true),
});

// Health check request schema
export const falHealthCheckRequestSchema = z.object({
  includeLatency: z.boolean().default(true),
  timeout: z.number().min(1000).max(30000).default(5000),
});

// Models request schema
export const falModelsRequestSchema = z.object({
  type: z.enum(["image", "video", "all"]).default("all"),
  includeCosts: z.boolean().default(false),
});

// Response schemas
export const falServiceResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  cached: z.boolean().optional(),
  latencyMs: z.number().optional(),
  cost: z.number().optional(),
  requestId: z.string().optional(),
});

export const falHealthResponseSchema = z.object({
  healthy: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export const falUsageStatsResponseSchema = z.object({
  totalRequests: z.number().int().min(0),
  totalCost: z.number().min(0),
  averageLatency: z.number().min(0),
  successRate: z.number().min(0).max(1),
  modelBreakdown: z.record(
    z.string(),
    z.object({
      requests: z.number().int().min(0),
      cost: z.number().min(0),
    }),
  ),
});

// Type exports
export type FalRequestStatus = z.infer<typeof falRequestStatusSchema>;
export type FalRequest = z.infer<typeof falRequestSchema>;
export type FalRequestInsert = z.infer<typeof falRequestInsertSchema>;
export type FalRequestUpdate = z.infer<typeof falRequestUpdateSchema>;
export type FalImageGenerationRequest = z.infer<
  typeof falImageGenerationRequestSchema
>;
export type FalVideoGenerationRequest = z.infer<
  typeof falVideoGenerationRequestSchema
>;
export type FalUsageStatsRequest = z.infer<typeof falUsageStatsRequestSchema>;
export type FalHealthCheckRequest = z.infer<typeof falHealthCheckRequestSchema>;
export type FalModelsRequest = z.infer<typeof falModelsRequestSchema>;
export type FalServiceResponse = z.infer<typeof falServiceResponseSchema>;
export type FalHealthResponse = z.infer<typeof falHealthResponseSchema>;
export type FalUsageStatsResponse = z.infer<typeof falUsageStatsResponseSchema>;
