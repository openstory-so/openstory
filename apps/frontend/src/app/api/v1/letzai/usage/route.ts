/**
 * LetzAI usage endpoint
 * GET /api/v1/letzai/usage - Get usage statistics and analytics
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/errors";
import { getLetzAIService } from "@/lib/letzai/service";

// Query parameters schema
const usageQuerySchema = z.object({
  teamId: z.string().uuid("Invalid team ID format"),
  startDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  endDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  endpoint: z
    .enum(["/images", "/image-edits", "/upscale", "/models"])
    .optional(),
  groupBy: z.enum(["day", "week", "month"]).optional().default("day"),
});

/**
 * GET handler for usage statistics
 */
export async function GET(request: Request) {
  try {
    // Parse query parameters
    const url = new URL(request.url);
    const queryParams = {
      teamId: url.searchParams.get("teamId"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
      endpoint: url.searchParams.get("endpoint"),
      groupBy: url.searchParams.get("groupBy"),
    };

    const { teamId, startDate, endDate, endpoint, groupBy } =
      usageQuerySchema.parse(queryParams);

    // Get LetzAI service instance
    const letzaiService = getLetzAIService();

    // Get usage statistics
    const stats = await letzaiService.getUsageStats({
      teamId,
      startDate,
      endDate,
      endpoint,
    });

    // Calculate additional metrics
    const currentPeriod = new Date();
    const previousPeriodStart = startDate
      ? new Date(startDate)
      : new Date(currentPeriod.getTime() - 30 * 24 * 60 * 60 * 1000);
    const previousPeriodEnd = startDate
      ? new Date(startDate.getTime() - 1)
      : new Date(currentPeriod.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get previous period stats for comparison
    const previousStats = await letzaiService.getUsageStats({
      teamId,
      startDate: previousPeriodStart,
      endDate: previousPeriodEnd,
      endpoint,
    });

    // Calculate growth rates
    const requestGrowth =
      previousStats.totalRequests > 0
        ? ((stats.totalRequests - previousStats.totalRequests) /
            previousStats.totalRequests) *
          100
        : 0;

    const costGrowth =
      previousStats.totalCost > 0
        ? ((stats.totalCost - previousStats.totalCost) /
            previousStats.totalCost) *
          100
        : 0;

    const response = {
      success: true,
      usage: {
        current: {
          ...stats,
          period: {
            start:
              startDate?.toISOString() ||
              new Date(
                currentPeriod.getTime() - 30 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            end: endDate?.toISOString() || currentPeriod.toISOString(),
          },
        },
        previous: {
          ...previousStats,
          period: {
            start: previousPeriodStart.toISOString(),
            end: previousPeriodEnd.toISOString(),
          },
        },
        growth: {
          requests: requestGrowth,
          cost: costGrowth,
        },
        trends: {
          // Most used endpoint
          topEndpoint:
            Object.entries(stats.requestsByEndpoint).sort(
              ([, a], [, b]) => b - a,
            )[0]?.[0] || null,
          // Cost efficiency (requests per credit)
          costEfficiency:
            stats.totalCost > 0 ? stats.totalRequests / stats.totalCost : 0,
          // Average request cost
          averageRequestCost:
            stats.totalRequests > 0 ? stats.totalCost / stats.totalRequests : 0,
        },
      },
      timestamp: new Date().toISOString(),
      metadata: {
        teamId,
        endpoint,
        groupBy,
        currency: "credits",
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[LetzAI Usage] Failed to fetch usage stats:", error);

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch usage statistics",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
