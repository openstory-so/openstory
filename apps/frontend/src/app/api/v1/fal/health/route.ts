import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { getFalService } from "@/lib/fal/service";

/**
 * GET handler for basic health check (no body required)
 */
export async function GET() {
  try {
    const falService = getFalService();
    const healthStatus = await falService.checkStatus();

    const response = {
      success: true,
      service: "fal.ai",
      status: healthStatus.success ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      latencyMs: healthStatus.latencyMs,
      ...(healthStatus.error && {
        error: healthStatus.error,
      }),
    };

    const statusCode = healthStatus.success ? 200 : 503;
    return NextResponse.json(response, { status: statusCode });
  } catch (error) {
    console.error("[Fal Health] Health check failed:", error);

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        service: "fal.ai",
        status: "error",
        message: handledError.message,
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
