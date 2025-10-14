/**
 * Job status endpoint
 * Retrieves status and details for a specific job
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, ValidationError, VelroError } from "@/lib/errors";
import { getJobManager } from "@/lib/qstash/job-manager";

// Query parameters schema
const statusQuerySchema = z.object({
  includeEvents: z
    .string()
    .nullable()
    .optional()
    .transform((val) => val === "true"),
  includeResult: z
    .string()
    .nullable()
    .optional()
    .transform((val) => val !== "false" && val !== null), // Default to true
});

interface JobStatusResponse {
  success: boolean;
  job: {
    id: string;
    type: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    userId?: string | null;
    teamId?: string | null;
    result?: Record<string, unknown> | null;
    error?: string | null;
    events?: Array<{
      id: string;
      event: string;
      data: Record<string, unknown> | null;
      createdAt: string;
    }>;
  };
  message: string;
  timestamp: string;
}

/**
 * GET handler for retrieving job status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: jobId } = await params;

    console.log("[JobStatus] Received status request", {
      jobId,
      url: request.url,
    });

    // Validate job ID format
    if (!jobId || typeof jobId !== "string") {
      throw new ValidationError("Invalid job ID", {
        jobId,
      });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const queryParams = statusQuerySchema.parse({
      includeEvents: searchParams.get("includeEvents"),
      includeResult: searchParams.get("includeResult"),
    });

    console.log("[JobStatus] Query parameters", {
      jobId,
      includeEvents: queryParams.includeEvents,
      includeResult: queryParams.includeResult,
    });

    // Get job from database
    const jobManager = getJobManager();
    const job = await jobManager.getJob(jobId, queryParams.includeEvents);

    if (!job) {
      console.log("[JobStatus] Job not found", { jobId });

      throw new VelroError("Job not found", "JOB_NOT_FOUND", 404, { jobId });
    }

    console.log("[JobStatus] Job found", {
      jobId: job.id,
      status: job.status,
      type: job.type,
      createdAt: job.created_at,
      hasResult: !!job.result,
      hasError: !!job.error,
      hasEvents: !!job.events && job.events.length > 0,
    });

    // Prepare response
    const response: JobStatusResponse = {
      success: true,
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        userId: job.user_id,
        teamId: job.team_id,
        error: job.error,
      },
      message: `Job status retrieved successfully`,
      timestamp: new Date().toISOString(),
    };

    // Include result if requested and available
    if (queryParams.includeResult && job.result) {
      response.job.result = job.result as Record<string, unknown>;
    }

    // Include events if requested and available
    if (queryParams.includeEvents && job.events) {
      response.job.events = job.events.map((event) => ({
        id: event.id,
        event: event.event,
        data: event.data,
        createdAt: event.createdAt,
      }));
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[JobStatus] Failed to get job status", {
      jobId: (await params)?.id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to get job status",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}

/**
 * OPTIONS handler for CORS
 */
export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}
