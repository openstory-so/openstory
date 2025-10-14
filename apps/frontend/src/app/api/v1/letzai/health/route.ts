/**
 * LetzAI health endpoint
 * GET /api/v1/letzai/health - Check LetzAI service health and connectivity
 */

import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { getLetzAIService } from "@/lib/letzai/service";

/**
 * GET handler for LetzAI health check
 */
export async function GET() {
  try {
    // Get LetzAI service instance
    const letzaiService = getLetzAIService();

    // Check health status
    const health = await letzaiService.getHealthStatus();

    const response = {
      success: true,
      service: "letzai",
      healthy: health.healthy,
      latencyMs: health.latencyMs,
      timestamp: new Date().toISOString(),
      ...(health.error && { error: health.error }),
    };

    // Return appropriate status code based on health
    const statusCode = health.healthy ? 200 : 503;

    return NextResponse.json(response, { status: statusCode });
  } catch (error) {
    console.error("[LetzAI Health] Health check failed:", error);

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        service: "letzai",
        healthy: false,
        message: "Health check failed",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
