/**
 * Zod schemas for LetzAI API requests and responses
 */

import { z } from "zod";

// LetzAI request status enum
export const letzaiRequestStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

// LetzAI API endpoints
export const letzaiEndpointSchema = z.enum([
  "/images",
  "/image-edits",
  "/upscale",
  "/models",
]);

// LetzAI image generation modes
export const letzaiModeSchema = z.enum([
  "default",
  "sigma",
  "turbo",
  "cinematic",
]);

// LetzAI image editing modes
export const letzaiEditModeSchema = z.enum(["context", "in", "out", "skin"]);

// LetzAI model classes
export const letzaiModelClassSchema = z.enum(["person", "object", "style"]);

// Base LetzAI image generation request
export const letzaiImageRequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  width: z.number().int().min(520).max(2160).default(1600),
  height: z.number().int().min(520).max(2160).default(1600),
  quality: z.number().int().min(1).max(5).default(5),
  creativity: z.number().int().min(1).max(5).default(2),
  hasWatermark: z.boolean().default(false),
  systemVersion: z
    .number()
    .int()
    .refine((val) => val === 2 || val === 3)
    .default(2),
  mode: letzaiModeSchema.default("cinematic"),
});

// LetzAI image editing request
export const letzaiImageEditRequestSchema = z.object({
  mode: letzaiEditModeSchema,
  imageCompletionsCount: z.number().int().min(1).max(3).default(3),
  prompt: z.string().optional(),
  mask: z.string().optional(), // base64 encoded mask
  imageUrl: z.string().url(),
  settings: z
    .object({
      // Outpaint settings
      panControls: z
        .object({
          up: z.boolean(),
          right: z.boolean(),
          down: z.boolean(),
          left: z.boolean(),
        })
        .optional(),
      zoomSize: z.number().default(1.5).optional(),
      // Skin fix settings
      face: z.boolean().default(true).optional(),
      body: z.boolean().default(true).optional(),
      eyes: z.boolean().default(false).optional(),
      mouth: z.boolean().default(false).optional(),
      nose: z.boolean().default(false).optional(),
      intensity: z.number().int().min(1).max(5).default(2).optional(),
    })
    .optional(),
});

// LetzAI upscale request
export const letzaiUpscaleRequestSchema = z
  .object({
    imageId: z.string().optional(),
    imageUrl: z.string().url().optional(),
    strength: z.number().int().min(1).max(3),
  })
  .refine((data) => data.imageId || data.imageUrl, {
    message: "Either imageId or imageUrl must be provided",
  });

// LetzAI image response
export const letzaiImageResponseSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  status: z.enum(["new", "in progress", "ready", "failed"]),
  progress: z.number().int().min(0).max(100),
  previewImage: z.string().optional(), // base64
  hasWatermark: z.boolean(),
  privacy: z.enum(["private", "public"]),
  createdAt: z.string(),
  imageVersions: z.record(z.string(), z.string()).optional(), // Maps resolution to URLs
});

// LetzAI image edit response
export const letzaiImageEditResponseSchema = z.object({
  id: z.string(),
  originalImageCompletion: z.object({
    imageVersions: z.record(z.string(), z.string()).optional(),
  }),
  generatedImageCompletion: z.object({
    imageVersions: z.record(z.string(), z.string()).optional(),
  }),
  mode: letzaiEditModeSchema,
  status: z.enum([
    "new",
    "generating",
    "ready",
    "saved",
    "failed",
    "interrupted",
  ]),
  progress: z.number().int().min(0).max(100).optional(),
  prompt: z.string().optional(),
  settings: z.object({}).optional(),
  imageVersions: z.record(z.string(), z.string()).optional(),
});

// LetzAI model response
export const letzaiModelResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  class: letzaiModelClassSchema,
  createdAt: z.string(),
});

// LetzAI service request (internal)
export const letzaiServiceRequestSchema = z.object({
  endpoint: letzaiEndpointSchema,
  parameters: z.record(z.string(), z.unknown()),
  userId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  jobId: z.string().optional(),
});

// Database record schema
export const letzaiRequestDbSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().nullable(),
  team_id: z.string().uuid().nullable(),
  user_id: z.string().uuid().nullable(),
  endpoint: z.string(),
  model: z.string().nullable(),
  request_payload: z.record(z.string(), z.unknown()),
  status: letzaiRequestStatusSchema,
  response_data: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  cost_credits: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

// Export types
export type LetzAIRequestStatus = z.infer<typeof letzaiRequestStatusSchema>;
export type LetzAIEndpoint = z.infer<typeof letzaiEndpointSchema>;
export type LetzAIMode = z.infer<typeof letzaiModeSchema>;
export type LetzAIEditMode = z.infer<typeof letzaiEditModeSchema>;
export type LetzAIModelClass = z.infer<typeof letzaiModelClassSchema>;
export type LetzAIImageRequest = z.infer<typeof letzaiImageRequestSchema>;
export type LetzAIImageEditRequest = z.infer<
  typeof letzaiImageEditRequestSchema
>;
export type LetzAIUpscaleRequest = z.infer<typeof letzaiUpscaleRequestSchema>;
export type LetzAIImageResponse = z.infer<typeof letzaiImageResponseSchema>;
export type LetzAIImageEditResponse = z.infer<
  typeof letzaiImageEditResponseSchema
>;
export type LetzAIModelResponse = z.infer<typeof letzaiModelResponseSchema>;
export type LetzAIServiceRequest = z.infer<typeof letzaiServiceRequestSchema>;
export type LetzAIRequestDb = z.infer<typeof letzaiRequestDbSchema>;
