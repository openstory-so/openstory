/**
 * LetzAI models endpoint
 * GET /api/v1/letzai/models - List available LetzAI models with metadata
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/errors";
import { getLetzAIService } from "@/lib/letzai/service";

// Query parameters schema
const modelsQuerySchema = z.object({
  page: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .default(1),
  limit: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .default(10),
  sortBy: z.enum(["createdAt", "usages"]).optional().default("createdAt"),
  sortOrder: z.enum(["ASC", "DESC"]).optional().default("DESC"),
  class: z.enum(["person", "object", "style"]).optional(),
  includeCosts: z
    .string()
    .nullable()
    .optional()
    .transform((val) => val === "true")
    .default(false),
});

/**
 * GET handler for available models
 */
export async function GET(request: Request) {
  try {
    // Parse query parameters
    const url = new URL(request.url);
    const queryParams = {
      page: url.searchParams.get("page"),
      limit: url.searchParams.get("limit"),
      sortBy: url.searchParams.get("sortBy"),
      sortOrder: url.searchParams.get("sortOrder"),
      class: url.searchParams.get("class"),
      includeCosts: url.searchParams.get("includeCosts"),
    };

    const {
      page,
      limit,
      sortBy,
      sortOrder,
      class: modelClass,
      includeCosts,
    } = modelsQuerySchema.parse(queryParams);

    // Get LetzAI service instance
    const letzaiService = getLetzAIService();

    // Get available models
    const result = await letzaiService.getModels({
      page,
      limit,
      sortBy,
      sortOrder,
      class: modelClass,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Failed to fetch models",
          error: result.error,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      );
    }

    // Enhance models with cost information if requested
    let models = result.data || [];
    if (includeCosts && Array.isArray(models)) {
      models = models.map((model) => ({
        ...model,
        estimatedCost: letzaiService.calculateCost("/models", {}),
        costUnit: "credits",
      }));
    }

    const response = {
      success: true,
      models,
      pagination: {
        page,
        limit,
        total: models.length,
      },
      timestamp: new Date().toISOString(),
      metadata: {
        sortBy,
        sortOrder,
        modelClass,
        includeCosts,
        supportedClasses: ["person", "object", "style"],
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[LetzAI Models] Failed to fetch models:", error);

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch available models",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}
