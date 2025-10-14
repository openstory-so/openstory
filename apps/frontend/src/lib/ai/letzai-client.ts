/**
 * LetzAI client for image generation and editing
 * Provides integration with LetzAI's generative media models
 */

import type { LetzAIServiceResponse } from "@/lib/letzai/service";
import { getLetzAIService } from "@/lib/letzai/service";
import type {
  LetzAIImageEditRequest,
  LetzAIImageEditResponse,
  LetzAIImageRequest,
  LetzAIImageResponse,
  LetzAIModelResponse,
  LetzAIUpscaleRequest,
} from "@/lib/schemas/letzai-request";

// LetzAI model constants
export const LETZAI_MODES = {
  default: "default",
  sigma: "sigma",
  turbo: "turbo",
  cinematic: "cinematic",
} as const;

export const LETZAI_EDIT_MODES = {
  context: "context",
  inpaint: "in",
  outpaint: "out",
  skin_fix: "skin",
} as const;

export const LETZAI_MODEL_CLASSES = {
  person: "person",
  object: "object",
  style: "style",
} as const;

// Type exports
export type LetzAIMode = keyof typeof LETZAI_MODES;
export type LetzAIEditMode = keyof typeof LETZAI_EDIT_MODES;
export type LetzAIModelClass = keyof typeof LETZAI_MODEL_CLASSES;

/**
 * Generate image using LetzAI
 */
export async function generateImage(params: {
  prompt: string;
  width?: number;
  height?: number;
  quality?: number;
  creativity?: number;
  hasWatermark?: boolean;
  systemVersion?: number;
  mode?: LetzAIMode;
  userId?: string;
  teamId?: string;
  jobId?: string;
}): Promise<LetzAIServiceResponse<LetzAIImageResponse>> {
  const letzaiService = getLetzAIService();

  const request: LetzAIImageRequest = {
    prompt: params.prompt,
    width: params.width || 1600,
    height: params.height || 1600,
    quality: params.quality || 2,
    creativity: params.creativity || 2,
    hasWatermark: params.hasWatermark ?? true,
    systemVersion: params.systemVersion || 2,
    mode: LETZAI_MODES[params.mode || "default"],
  };

  return letzaiService.generateImage(request, {
    userId: params.userId,
    teamId: params.teamId,
    jobId: params.jobId,
  });
}

/**
 * Edit image using LetzAI
 */
export async function editImage(params: {
  mode: LetzAIEditMode;
  imageUrl: string;
  prompt?: string;
  mask?: string;
  imageCompletionsCount?: number;
  settings?: {
    // Outpaint settings
    panControls?: {
      up: boolean;
      right: boolean;
      down: boolean;
      left: boolean;
    };
    zoomSize?: number;
    // Skin fix settings
    face?: boolean;
    body?: boolean;
    eyes?: boolean;
    mouth?: boolean;
    nose?: boolean;
    intensity?: number;
  };
  userId?: string;
  teamId?: string;
  jobId?: string;
}): Promise<LetzAIServiceResponse<LetzAIImageEditResponse>> {
  const letzaiService = getLetzAIService();

  const request: LetzAIImageEditRequest = {
    mode: LETZAI_EDIT_MODES[params.mode],
    imageUrl: params.imageUrl,
    prompt: params.prompt,
    mask: params.mask,
    imageCompletionsCount: params.imageCompletionsCount || 3,
    settings: params.settings,
  };

  return letzaiService.editImage(request, {
    userId: params.userId,
    teamId: params.teamId,
    jobId: params.jobId,
  });
}

/**
 * Upscale image using LetzAI
 */
export async function upscaleImage(params: {
  imageId?: string;
  imageUrl?: string;
  strength: number;
  userId?: string;
  teamId?: string;
  jobId?: string;
}): Promise<LetzAIServiceResponse<LetzAIImageResponse>> {
  const letzaiService = getLetzAIService();

  const request: LetzAIUpscaleRequest = {
    imageId: params.imageId,
    imageUrl: params.imageUrl,
    strength: params.strength,
  };

  return letzaiService.upscaleImage(request, {
    userId: params.userId,
    teamId: params.teamId,
    jobId: params.jobId,
  });
}

/**
 * Get available LetzAI models
 */
export async function getModels(params?: {
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "usages";
  sortOrder?: "ASC" | "DESC";
  class?: LetzAIModelClass;
}): Promise<LetzAIServiceResponse<LetzAIModelResponse[]>> {
  const letzaiService = getLetzAIService();

  return letzaiService.getModels({
    page: params?.page,
    limit: params?.limit,
    sortBy: params?.sortBy,
    sortOrder: params?.sortOrder,
    class: params?.class ? LETZAI_MODEL_CLASSES[params.class] : undefined,
  });
}

/**
 * Check status of a LetzAI job
 */
export async function checkJobStatus(
  jobId: string,
  endpoint: "/images" | "/image-edits" | "/upscale" = "/images",
): Promise<LetzAIServiceResponse> {
  const letzaiService = getLetzAIService();
  return letzaiService.checkStatus(jobId, endpoint);
}

/**
 * Get LetzAI service health status
 */
export async function getHealthStatus(): Promise<{
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const letzaiService = getLetzAIService();
  return letzaiService.getHealthStatus();
}

/**
 * Get usage statistics for a team
 */
export async function getUsageStats(params: {
  teamId: string;
  startDate?: Date;
  endDate?: Date;
  endpoint?: "/images" | "/image-edits" | "/upscale" | "/models";
}): Promise<{
  totalRequests: number;
  totalCost: number;
  averageLatency: number;
  successRate: number;
  requestsByEndpoint: Record<string, number>;
  costByEndpoint: Record<string, number>;
}> {
  const letzaiService = getLetzAIService();
  return letzaiService.getUsageStats(params);
}

/**
 * Calculate estimated cost for a LetzAI request
 */
export function calculateCost(
  endpoint: "/images" | "/image-edits" | "/upscale" | "/models",
  parameters: Record<string, unknown>,
): number {
  const letzaiService = getLetzAIService();
  return letzaiService.calculateCost(endpoint, parameters);
}
