/**
 * Fal.ai Service Layer
 * Enterprise-ready AI service with unified response format, error handling,
 * database logging, usage tracking, and cost calculation
 */

import { createFalClient } from "@fal-ai/client";
import { db } from "@/db";
import { falRequests } from "@/db/schema/ai-requests";
import type { FalImageModel, FalVideoModel } from "./models";
import { MODEL_PRICING } from "./models";
import { eq, and } from "drizzle-orm";

// Fal.ai client configuration
const falClient = createFalClient({
  credentials: process.env.FAL_KEY,
});

// Service response interface
export interface FalServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs?: number;
  cost?: number;
  requestId?: string;
}

// Request options
export interface FalRequestOptions {
  userId?: string;
  teamId?: string;
  jobId?: string;
  timeout?: number;
}

/**
 * Fal.ai Service Class
 * Handles all Fal.ai API interactions with enterprise features
 */
export class FalService {
  /**
   * Generate image using Fal.ai
   */
  async generateImage(
    model: FalImageModel,
    params: Record<string, unknown>,
    options?: FalRequestOptions
  ): Promise<FalServiceResponse> {
    return this.executeRequest({
      model,
      parameters: params,
      ...options,
    });
  }

  /**
   * Generate video using Fal.ai
   */
  async generateVideo(
    model: FalVideoModel,
    params: Record<string, unknown>,
    options?: FalRequestOptions
  ): Promise<FalServiceResponse> {
    return this.executeRequest({
      model,
      parameters: params,
      ...options,
    });
  }

  /**
   * Execute Fal.ai request with full service layer features
   */
  private async executeRequest(request: {
    model: string;
    parameters: Record<string, unknown>;
    userId?: string;
    teamId?: string;
    jobId?: string;
  }): Promise<FalServiceResponse> {
    const startTime = Date.now();

    // Create database record for tracking
    const [dbRecord] = await db
      .insert(falRequests)
      .values({
        model: request.model,
        requestPayload: request.parameters,
        userId: request.userId || null,
        teamId: request.teamId || null,
        jobId: request.jobId || null,
        status: "pending",
      })
      .returning();

    try {
      // Execute the actual API request with retry logic
      const result = await this.makeApiRequest(
        request.model,
        request.parameters
      );

      const latencyMs = Date.now() - startTime;
      const cost = this.calculateCost(request.model, request.parameters);

      // Update database record with success
      await db
        .update(falRequests)
        .set({
          status: "completed",
          responseData: result,
          latencyMs,
          costCredits: cost.toString(),
        })
        .where(eq(falRequests.id, dbRecord!.id));

      return {
        success: true,
        data: result,
        latencyMs,
        cost,
        requestId: dbRecord!.id,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Update database record with error
      await db
        .update(falRequests)
        .set({
          status: "failed",
          error: errorMessage,
          latencyMs,
        })
        .where(eq(falRequests.id, dbRecord!.id));

      console.error("[Fal.ai] Request failed:", error);

      return {
        success: false,
        error: errorMessage,
        latencyMs,
        requestId: dbRecord!.id,
      };
    }
  }

  /**
   * Make API request to Fal.ai with retry logic
   */
  private async makeApiRequest(
    model: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await falClient.run(model, {
          input: params,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on 4xx errors (client errors)
        const status = this.extractStatusCode(error);
        if (status && status >= 400 && status < 500) {
          throw lastError;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < maxRetries - 1) {
          const delayMs = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Extract HTTP status code from error
   */
  private extractStatusCode(error: unknown): number | null {
    if (error && typeof error === "object") {
      const err = error as Record<string, unknown>;
      if (typeof err.status === "number") return err.status;
      if (typeof err.statusCode === "number") return err.statusCode;
    }
    return null;
  }

  /**
   * Calculate cost for a Fal.ai request
   */
  calculateCost(model: string, params: Record<string, unknown>): number {
    const baseCost = MODEL_PRICING[model as keyof typeof MODEL_PRICING] || 0;

    // Adjust cost based on parameters (e.g., resolution, duration)
    let multiplier = 1;

    // Image resolution multiplier
    if (params.width && params.height) {
      const pixels = (params.width as number) * (params.height as number);
      const basePixels = 1024 * 1024; // 1MP
      multiplier *= pixels / basePixels;
    }

    // Video duration multiplier
    if (params.duration) {
      multiplier *= params.duration as number;
    }

    return baseCost * multiplier;
  }

  /**
   * Check Fal.ai service health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      // Make a minimal request to check service availability
      await falClient.run("fal-ai/flux/schnell", {
        input: {
          prompt: "health check",
          num_inference_steps: 1,
        },
      });

      return {
        healthy: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get usage statistics for a team or user
   */
  async getUsageStats(params: {
    teamId?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalRequests: number;
    completedRequests: number;
    failedRequests: number;
    totalCost: number;
    averageLatency: number;
  }> {
    const { teamId, userId } = params;

    // Build query with proper where conditions
    const conditions = [];
    if (teamId) {
      conditions.push(eq(falRequests.teamId, teamId));
    }
    if (userId) {
      conditions.push(eq(falRequests.userId, userId));
    }

    // Execute query
    const requests = conditions.length > 0
      ? await db.select().from(falRequests).where(and(...conditions))
      : await db.select().from(falRequests);

    // Calculate statistics
    const totalRequests = requests.length;
    const completedRequests = requests.filter(
      (r) => r.status === "completed"
    ).length;
    const failedRequests = requests.filter((r) => r.status === "failed").length;
    const totalCost = requests.reduce((sum, r) => sum + (Number(r.costCredits) || 0), 0);
    const totalLatency = requests.reduce((sum, r) => sum + (r.latencyMs || 0), 0);
    const averageLatency = totalRequests > 0 ? totalLatency / totalRequests : 0;

    return {
      totalRequests,
      completedRequests,
      failedRequests,
      totalCost,
      averageLatency,
    };
  }
}

// Singleton instance
let falServiceInstance: FalService | null = null;

/**
 * Get Fal.ai service instance
 */
export function getFalService(): FalService {
  if (!falServiceInstance) {
    falServiceInstance = new FalService();
  }
  return falServiceInstance;
}

