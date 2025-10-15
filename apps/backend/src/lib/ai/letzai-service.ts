/**
 * LetzAI Service Layer
 * Enterprise-ready AI service with unified response format, error handling,
 * database logging, usage tracking, and cost calculation
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { letzaiRequests } from "@/db/schema/ai-requests";

// LetzAI API configuration
const LETZAI_API_URL = "https://api.letz.ai";
const POLL_INTERVAL_MS = 3000; // 3 seconds as recommended by LetzAI

// Service response interface
export interface LetzAIServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs?: number;
  cost?: number;
  requestId?: string;
}

// Request options
export interface LetzAIRequestOptions {
  userId?: string;
  teamId?: string;
  jobId?: string;
}

// LetzAI image generation request
export interface LetzAIImageRequest {
  prompt: string;
  width?: number;
  height?: number;
  quality?: number;
  creativity?: number;
  hasWatermark?: boolean;
  systemVersion?: number;
  mode?: string;
}

// LetzAI image response
export interface LetzAIImageResponse {
  id: string;
  prompt: string;
  status: "new" | "in progress" | "ready" | "failed";
  progress: number;
  previewImage?: string;
  images?: Array<{
    id: string;
    url: string;
    width: number;
    height: number;
  }>;
}

/**
 * LetzAI Service Class
 * Handles all LetzAI API interactions with enterprise features
 */
export class LetzAIService {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.LETZAI_API_KEY;
    if (!apiKey) {
      throw new Error("LETZAI_API_KEY environment variable is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Generate image using LetzAI
   */
  async generateImage(
    params: LetzAIImageRequest,
    options?: LetzAIRequestOptions,
  ): Promise<LetzAIServiceResponse<LetzAIImageResponse>> {
    return this.executeRequest({
      endpoint: "/images",
      parameters: params as unknown as Record<string, unknown>,
      ...options,
    }) as Promise<LetzAIServiceResponse<LetzAIImageResponse>>;
  }

  /**
   * Execute LetzAI request with full service layer features
   */
  private async executeRequest(request: {
    endpoint: string;
    parameters: Record<string, unknown>;
    userId?: string;
    teamId?: string;
    jobId?: string;
  }): Promise<LetzAIServiceResponse> {
    const startTime = Date.now();

    // Create database record for tracking
    const [dbRecord] = await db
      .insert(letzaiRequests)
      .values({
        endpoint: request.endpoint,
        requestPayload: request.parameters,
        userId: request.userId || null,
        teamId: request.teamId || null,
        jobId: request.jobId || null,
        status: "pending",
      })
      .returning();

    try {
      // Execute the actual API request
      const result = await this.makeApiRequest(
        request.endpoint,
        request.parameters,
      );

      const latencyMs = Date.now() - startTime;
      const cost = this.calculateCost(request.endpoint, request.parameters);

      // Update database record with success
      await db
        .update(letzaiRequests)
        .set({
          status: "completed",
          responseData: result,
          latencyMs,
          costCredits: cost.toString(),
        })
        .where(eq(letzaiRequests.id, dbRecord?.id));

      return {
        success: true,
        data: result,
        latencyMs,
        cost,
        requestId: dbRecord?.id,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Update database record with error
      await db
        .update(letzaiRequests)
        .set({
          status: "failed",
          error: errorMessage,
          latencyMs,
        })
        .where(eq(letzaiRequests.id, dbRecord?.id));

      console.error("[LetzAI] Request failed:", error);

      return {
        success: false,
        error: errorMessage,
        latencyMs,
        requestId: dbRecord?.id,
      };
    }
  }

  /**
   * Make API request to LetzAI
   */
  private async makeApiRequest(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Submit job to LetzAI
    const submitResponse = await fetch(`${LETZAI_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!submitResponse.ok) {
      const error = await submitResponse.text();
      throw new Error(`LetzAI API error: ${submitResponse.status} ${error}`);
    }

    const submitData = (await submitResponse.json()) as { id: string };
    const jobId = submitData.id;

    // Poll for completion
    return this.pollForCompletion(endpoint, jobId);
  }

  /**
   * Poll LetzAI job until completion
   */
  private async pollForCompletion(
    endpoint: string,
    jobId: string,
  ): Promise<unknown> {
    const maxAttempts = 60; // 3 minutes max (60 * 3s)
    let attempts = 0;

    while (attempts < maxAttempts) {
      const statusResponse = await fetch(
        `${LETZAI_API_URL}${endpoint}/${jobId}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      if (!statusResponse.ok) {
        throw new Error(`Failed to check job status: ${statusResponse.status}`);
      }

      const statusData = (await statusResponse.json()) as { status: string };

      if (statusData.status === "ready") {
        return statusData;
      }

      if (statusData.status === "failed") {
        throw new Error("LetzAI job failed");
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      attempts++;
    }

    throw new Error("LetzAI job timed out");
  }

  /**
   * Calculate cost for a LetzAI request
   */
  calculateCost(_endpoint: string, params: Record<string, unknown>): number {
    // LetzAI pricing (approximate)
    const baseCost = 0.02; // $0.02 per image

    // Adjust cost based on parameters
    let multiplier = 1;

    // Quality multiplier
    if (params.quality) {
      multiplier *= (params.quality as number) / 3;
    }

    // Resolution multiplier
    if (params.width && params.height) {
      const pixels = (params.width as number) * (params.height as number);
      const basePixels = 1600 * 1600;
      multiplier *= pixels / basePixels;
    }

    return baseCost * multiplier;
  }

  /**
   * Check LetzAI service health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      // Check if API is accessible
      const response = await fetch(`${LETZAI_API_URL}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

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
  async getUsageStats(params: { teamId?: string; userId?: string }): Promise<{
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
      conditions.push(eq(letzaiRequests.teamId, teamId));
    }
    if (userId) {
      conditions.push(eq(letzaiRequests.userId, userId));
    }

    // Execute query
    const requests =
      conditions.length > 0
        ? await db
            .select()
            .from(letzaiRequests)
            .where(and(...conditions))
        : await db.select().from(letzaiRequests);

    // Calculate statistics
    const totalRequests = requests.length;
    const completedRequests = requests.filter(
      (r) => r.status === "completed",
    ).length;
    const failedRequests = requests.filter((r) => r.status === "failed").length;
    const totalCost = requests.reduce(
      (sum, r) => sum + (Number(r.costCredits) || 0),
      0,
    );
    const totalLatency = requests.reduce(
      (sum, r) => sum + (r.latencyMs || 0),
      0,
    );
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
let letzaiServiceInstance: LetzAIService | null = null;

/**
 * Get LetzAI service instance
 */
export function getLetzAIService(): LetzAIService {
  if (!letzaiServiceInstance) {
    letzaiServiceInstance = new LetzAIService();
  }
  return letzaiServiceInstance;
}
