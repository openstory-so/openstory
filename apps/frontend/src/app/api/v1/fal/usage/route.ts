/**
 * Fal.ai usage statistics endpoint
 * GET /api/v1/fal/usage - Get usage statistics for Fal.ai API
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { handleApiError, ValidationError } from "@/lib/errors";
import { getFalService } from "@/lib/fal/service";

// Query parameters schema
const usageQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(["day", "week", "month", "year"]).optional().default("month"),
  includeBreakdown: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? undefined : val === "true"))
    .default(true),
});

/**
 * GET handler for usage statistics
 */
export async function GET(request: Request) {
  try {
    // Check authentication with BetterAuth
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json(
        {
          success: false,
          message: "Authentication required",
          timestamp: new Date().toISOString(),
        },
        { status: 401 },
      );
    }

    // Parse query parameters
    const url = new URL(request.url);
    const queryParams = {
      teamId: url.searchParams.get("teamId"),
      userId: url.searchParams.get("userId"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
      period: url.searchParams.get("period"),
      includeBreakdown: url.searchParams.get("includeBreakdown") ?? undefined,
    };

    const { teamId, userId, startDate, endDate, period, includeBreakdown } =
      usageQuerySchema.parse(queryParams);

    // Calculate date range based on period if not provided
    let calculatedStartDate: Date;
    let calculatedEndDate: Date = new Date();

    if (startDate && endDate) {
      calculatedStartDate = new Date(startDate);
      calculatedEndDate = new Date(endDate);
    } else {
      // Calculate based on period
      calculatedStartDate = new Date();
      switch (period) {
        case "day":
          calculatedStartDate.setDate(calculatedStartDate.getDate() - 1);
          break;
        case "week":
          calculatedStartDate.setDate(calculatedStartDate.getDate() - 7);
          break;
        case "month":
          calculatedStartDate.setMonth(calculatedStartDate.getMonth() - 1);
          break;
        case "year":
          calculatedStartDate.setFullYear(
            calculatedStartDate.getFullYear() - 1,
          );
          break;
      }
    }

    // Validate date range
    if (calculatedStartDate >= calculatedEndDate) {
      throw new ValidationError("Start date must be before end date");
    }

    // Get Fal service instance
    const falService = getFalService();

    // Fetch usage statistics
    const usageStats = await falService.getUsageStats({
      teamId,
      userId,
      startDate: calculatedStartDate,
      endDate: calculatedEndDate,
    });

    // Prepare response
    const response = {
      success: true,
      usage: {
        totalRequests: usageStats.totalRequests,
        totalCost: usageStats.totalCost,
        averageLatency: Math.round(usageStats.averageLatency),
        successRate: Math.round(usageStats.successRate * 100) / 100, // Round to 2 decimal places
        period: {
          type: period,
          startDate: calculatedStartDate.toISOString(),
          endDate: calculatedEndDate.toISOString(),
        },
        ...(includeBreakdown && {
          modelBreakdown: usageStats.modelBreakdown,
        }),
      },
      metadata: {
        filters: {
          teamId,
          userId,
        },
        generatedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Fal Usage] Failed to fetch usage statistics:", error);

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
