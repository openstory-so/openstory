/**
 * Job cancellation endpoint
 * Cancels a job and attempts to cancel the associated QStash message
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { handleApiError, ValidationError, VelroError } from "@/lib/errors";
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";

interface JobCancelResponse {
  success: boolean;
  jobId: string;
  status: string;
  message: string;
  timestamp: string;
  qstashCancelled?: boolean;
  warnings?: string[];
}

/**
 * POST handler for cancelling jobs
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: jobId } = await params;

    console.log("[JobCancel] Received cancellation request", {
      jobId,
      url: request.url,
    });

    // Validate job ID format
    if (!jobId || typeof jobId !== "string") {
      throw new ValidationError("Invalid job ID", {
        jobId,
      });
    }

    // Initialize services
    const jobManager = getJobManager();
    const _qstashClient = getQStashClient();

    // Get current job status
    const existingJob = await jobManager.getJob(jobId);

    if (!existingJob) {
      console.log("[JobCancel] Job not found", { jobId });

      throw new VelroError("Job not found", "JOB_NOT_FOUND", 404, { jobId });
    }

    console.log("[JobCancel] Found job", {
      jobId: existingJob.id,
      currentStatus: existingJob.status,
      createdAt: existingJob.created_at,
    });

    // Check if job can be cancelled
    if (existingJob.status === "completed") {
      console.log("[JobCancel] Job already completed", { jobId });

      return NextResponse.json(
        {
          success: false,
          jobId,
          status: existingJob.status,
          message: "Cannot cancel completed job",
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      ); // Conflict
    }

    if (existingJob.status === "cancelled") {
      console.log("[JobCancel] Job already cancelled", { jobId });

      return NextResponse.json({
        success: true,
        jobId,
        status: existingJob.status,
        message: "Job already cancelled",
        timestamp: new Date().toISOString(),
      });
    }

    // Cancel the job in database
    const cancelledJob = await jobManager.cancelJob(jobId);

    console.log("[JobCancel] Job cancelled in database", {
      jobId: cancelledJob.id,
      status: cancelledJob.status,
      completedAt: cancelledJob.completed_at,
    });

    const response: JobCancelResponse = {
      success: true,
      jobId: cancelledJob.id,
      status: cancelledJob.status,
      message: "Job cancelled successfully",
      timestamp: new Date().toISOString(),
    };

    // Try to cancel the QStash message if job was still pending/running
    if (existingJob.status === "pending" || existingJob.status === "running") {
      try {
        // Note: We would need to store the QStash message ID to cancel it
        // For now, we'll add a warning that the message might still be processed
        console.log(
          "[JobCancel] Job was in progress, QStash message may still be processed",
          {
            jobId,
            originalStatus: existingJob.status,
          },
        );

        response.warnings = [
          "Job was cancelled in database, but QStash message may still be processed. The webhook will detect the cancelled status and skip processing.",
        ];
      } catch (qstashError) {
        console.warn("[JobCancel] Failed to cancel QStash message", {
          jobId,
          error:
            qstashError instanceof Error
              ? qstashError.message
              : "Unknown error",
        });

        response.warnings = [
          "Job cancelled in database, but failed to cancel QStash message. The webhook will detect the cancelled status and skip processing.",
        ];
      }
    }

    console.log("[JobCancel] Job cancellation completed", {
      jobId,
      status: response.status,
      hasWarnings: !!response.warnings,
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("[JobCancel] Job cancellation failed", {
      jobId: (await params)?.id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to cancel job",
        error: handledError.toJSON(),
        timestamp: new Date().toISOString(),
      },
      { status: handledError.statusCode },
    );
  }
}

/**
 * GET handler for endpoint information
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params;

  return NextResponse.json({
    message: `Job cancellation endpoint for job ${jobId}`,
    usage: {
      method: "POST",
      description: "Cancel the specified job",
      notes: [
        "Only pending and running jobs can be cancelled",
        "Completed jobs cannot be cancelled",
        "Already cancelled jobs will return success",
        "QStash messages may still be processed but will be skipped",
      ],
    },
    jobId,
    timestamp: new Date().toISOString(),
  });
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
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}
