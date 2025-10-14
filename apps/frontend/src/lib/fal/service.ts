import { createFalClient } from "@fal-ai/client";
import type { FalImageModel, FalVideoModel } from "@/lib/ai/models";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/ai/models";
import { VelroError, withRetry } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/database";

// Request/Response types
export interface FalServiceRequest {
  model: string;
  parameters: Record<string, unknown>;
  userId?: string;
  teamId?: string;
  jobId?: string;
}

export interface FalServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs?: number;
  cost?: number;
  requestId?: string;
}

// Cost calculation mapping (in USD)
export const MODEL_COSTS: Record<string, number> = {
  // Image models
  [IMAGE_MODELS.flux_pro]: 0.05,
  [IMAGE_MODELS.flux_dev]: 0.025,
  [IMAGE_MODELS.flux_schnell]: 0.01,
  [IMAGE_MODELS.sdxl]: 0.02,
  [IMAGE_MODELS.sdxl_lightning]: 0.015,
  [IMAGE_MODELS.flux_pro_kontext_max]: 0.08, // per image
  [IMAGE_MODELS.imagen4_preview_ultra]: 0.06, // per image
  [IMAGE_MODELS.flux_pro_v1_1_ultra]: 0.06, // per image
  [IMAGE_MODELS.flux_krea_lora]: 0.035, // per mb

  // Video models
  [VIDEO_MODELS.minimax_hailuo]: 0.3,
  [VIDEO_MODELS.mochi_v1]: 0.25,
  [VIDEO_MODELS.luma_dream_machine]: 0.4,
  [VIDEO_MODELS.kling_v2]: 0.5,
  [VIDEO_MODELS.wan_i2v]: 0.35,
  [VIDEO_MODELS.kling_i2v]: 0.45,
  [VIDEO_MODELS.svd_lcm]: 0.15,
  [VIDEO_MODELS.veo3]: 0.8,
  [VIDEO_MODELS.veo2_i2v]: 0.6,
  [VIDEO_MODELS.wan_v2]: 0.55,
};

export const MODEL_TIME_ESTIMATES: Record<string, number> = {
  // Image models
  [IMAGE_MODELS.flux_pro]: 0.05,
  [IMAGE_MODELS.flux_dev]: 0.025,
  [IMAGE_MODELS.flux_schnell]: 0.01,
  [IMAGE_MODELS.sdxl]: 0.02,
  [IMAGE_MODELS.sdxl_lightning]: 0.015,
  [IMAGE_MODELS.flux_pro_kontext_max]: 0.08,
  [IMAGE_MODELS.imagen4_preview_ultra]: 0.06,
  [IMAGE_MODELS.flux_pro_v1_1_ultra]: 0.06,
  [IMAGE_MODELS.flux_krea_lora]: 0.035,

  // Video models
  [VIDEO_MODELS.minimax_hailuo]: 0.3,
  [VIDEO_MODELS.mochi_v1]: 0.25,
  [VIDEO_MODELS.luma_dream_machine]: 0.4,
  [VIDEO_MODELS.kling_v2]: 0.5,
  [VIDEO_MODELS.wan_i2v]: 0.35,
  [VIDEO_MODELS.kling_i2v]: 0.45,
  [VIDEO_MODELS.svd_lcm]: 0.15,
  [VIDEO_MODELS.veo3]: 0.8,
  [VIDEO_MODELS.veo2_i2v]: 0.6,
  [VIDEO_MODELS.wan_v2]: 0.55,
};

/**
 * Enhanced Fal.ai service class with comprehensive error handling and monitoring
 */
export class FalService {
  private supabase = createAdminClient();
  private fal;
  constructor() {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) {
      throw new VelroError(
        "FAL_KEY environment variable is required",
        "FAL_CONFIG_ERROR",
        500,
      );
    }
    this.fal = createFalClient({
      credentials: apiKey,
    });
  }

  /**
   * Generate image using Fal.ai with full service layer features
   */
  async generateImage(
    model: FalImageModel,
    params: Record<string, unknown>,
    options?: {
      userId?: string;
      teamId?: string;
      jobId?: string;
      timeout?: number;
    },
  ): Promise<FalServiceResponse> {
    return this.executeRequest({
      model,
      parameters: params,
      userId: options?.userId,
      teamId: options?.teamId,
      jobId: options?.jobId,
    });
  }

  /**
   * Generate video using Fal.ai with full service layer features
   */
  async generateVideo(
    model: FalVideoModel,
    params: Record<string, unknown>,
    options?: {
      userId?: string;
      teamId?: string;
      jobId?: string;
      timeout?: number;
    },
  ): Promise<FalServiceResponse> {
    return this.executeRequest({
      model,
      parameters: params,
      userId: options?.userId,
      teamId: options?.teamId,
      jobId: options?.jobId,
    });
  }

  /**
   * Check status of a Fal.ai job
   */
  async checkStatus(): Promise<FalServiceResponse> {
    try {
      // Use the FAL client's queue status method
      const status = await this.fal.queue.status("fal-ai/flux/dev", {
        requestId: "test",
      });
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      const code =
        (error as { status?: number; response?: { status?: number } })
          ?.status ??
        (error as { response?: { status?: number } })?.response?.status;
      if (code === 404)
        return {
          success: true,
        };
      if (code === 401)
        return {
          success: false,
          error: "Unauthorized — check FAL_KEY / proxy",
        };
      return {
        success: false,
        error: error instanceof Error ? error.message : "Status check failed",
      };
    }
  }

  /**
   * Calculate cost for a request
   */
  calculateCost(model: string, params: Record<string, unknown>): number {
    const baseCost = MODEL_COSTS[model] || 0.1; // Default cost

    // Adjust cost based on parameters
    let multiplier = 1;

    // For image generation
    if (params.num_images && typeof params.num_images === "number") {
      multiplier *= params.num_images;
    }

    // For video generation
    if (params.duration && typeof params.duration === "number") {
      multiplier *= Math.max(1, params.duration / 3); // Base 3 seconds
    }

    return baseCost * multiplier;
  }

  calculateTime(model: string, _params: Record<string, unknown>): number {
    const baseTime = MODEL_TIME_ESTIMATES[model] || 0.1; // Default time
    return baseTime;
  }

  /**
   * Get available models
   */
  getAvailableModels(): {
    image: Record<string, string>;
    video: Record<string, string>;
  } {
    return {
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
    };
  }

  /**
   * Get usage statistics for a team or user
   */
  async getUsageStats(options: {
    teamId?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalRequests: number;
    totalCost: number;
    averageLatency: number;
    successRate: number;
    modelBreakdown: Record<string, { requests: number; cost: number }>;
  }> {
    const { teamId, userId, startDate, endDate } = options;

    let query = this.supabase
      .from("fal_requests")
      .select("model, cost_credits, latency_ms, status, created_at");

    if (teamId) query = query.eq("team_id", teamId);
    if (userId) query = query.eq("user_id", userId);
    if (startDate) query = query.gte("created_at", startDate.toISOString());
    if (endDate) query = query.lte("created_at", endDate.toISOString());

    const { data: requests, error } = await query;

    if (error || !requests) {
      throw new VelroError(
        "Failed to fetch usage statistics",
        "FAL_USAGE_ERROR",
        500,
        { supabaseError: error?.message },
      );
    }

    const totalRequests = requests.length;
    const totalCost = requests.reduce(
      (sum, req) => sum + (req.cost_credits || 0),
      0,
    );
    const totalLatency = requests.reduce(
      (sum, req) => sum + (req.latency_ms || 0),
      0,
    );
    const successfulRequests = requests.filter(
      (req) => req.status === "completed",
    ).length;

    const modelBreakdown: Record<string, { requests: number; cost: number }> =
      {};
    for (const request of requests) {
      if (!modelBreakdown[request.model]) {
        modelBreakdown[request.model] = { requests: 0, cost: 0 };
      }
      modelBreakdown[request.model].requests++;
      modelBreakdown[request.model].cost += request.cost_credits || 0;
    }

    return {
      totalRequests,
      totalCost,
      averageLatency: totalRequests > 0 ? totalLatency / totalRequests : 0,
      successRate: totalRequests > 0 ? successfulRequests / totalRequests : 0,
      modelBreakdown,
    };
  }

  /**
   * Core request execution with all service layer features
   */
  private async executeRequest(
    request: FalServiceRequest,
  ): Promise<FalServiceResponse> {
    const startTime = Date.now();

    // Create database record
    const { data: dbRecord, error: dbError } = await this.supabase
      .from("fal_requests")
      .insert({
        job_id: request.jobId || null,
        team_id: request.teamId || null,
        user_id: request.userId || null,
        model: request.model,
        request_payload: request.parameters as Json,
        status: "pending",
      })
      .select()
      .single();

    if (dbError || !dbRecord) {
      console.error("[FalService] Failed to create database record:", dbError);
      return {
        success: false,
        error: "Failed to track request",
      };
    }

    try {
      // Execute the actual API request with retry logic
      const result = await withRetry(
        () => this.makeApiRequest(request.model, request.parameters),
        {
          attempts: 3,
          delayMs: 1000,
          backoffMultiplier: 2,
          shouldRetry: (error) => {
            const status = this.extractStatusCode(error);
            if (status && status >= 400 && status < 500) return false; // don't retry on 4xx
            return true;
          },
        },
      );

      const latencyMs = Date.now() - startTime;
      const cost = this.calculateCost(request.model, request.parameters);

      // Update database record with success
      await this.supabase
        .from("fal_requests")
        .update({
          status: "completed",
          response_data: result as Json,
          latency_ms: latencyMs,
          cost_credits: cost,
        })
        .eq("id", dbRecord.id);

      return {
        success: true,
        data: result,
        latencyMs,
        cost,
        requestId: dbRecord.id,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Update database record with failure
      await this.supabase
        .from("fal_requests")
        .update({
          status: "failed",
          error: errorMessage,
          latency_ms: latencyMs,
        })
        .eq("id", dbRecord.id);

      return {
        success: false,
        error: errorMessage,
        latencyMs,
        requestId: dbRecord.id,
      };
    }
  }

  private extractStatusCode(error: unknown): number | undefined {
    const e = error as {
      status?: number;
      response?: { status?: number };
      cause?: { status?: number };
    };
    return e?.status ?? e?.response?.status ?? e?.cause?.status;
  }

  /**
   * Make the actual API request to Fal.ai using the official client
   */
  private async makeApiRequest(
    model: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      // Use the official FAL client with subscribe for real-time updates
      const result = await this.fal.subscribe(model, {
        input: parameters,
        logs: true,
        onQueueUpdate: (update) => {
          console.log("update in onQueueUpdate", update);
          // Log progress for debugging
          if (update.status === "IN_PROGRESS") {
            console.log(`[FAL] ${model} - ${update.status}`);
            if (update.logs) {
              update.logs.forEach((log) => {
                console.log(`[FAL] ${log.message}`);
              });
            }
          }
        },
      });

      return result;
    } catch (error) {
      // Re-throw with more context while preserving status for retry logic
      throw new Error(
        `FAL API request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Singleton instance of FalService
 */
let falServiceInstance: FalService | null = null;

export function getFalService(): FalService {
  if (!falServiceInstance) {
    falServiceInstance = new FalService();
  }
  return falServiceInstance;
}
