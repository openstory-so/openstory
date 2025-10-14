/**
 * Job creation endpoint
 * Creates new jobs and publishes them to QStash for async processing
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, ValidationError } from "@/lib/errors";
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager, JobType } from "@/lib/qstash/job-manager";
import type {
  ImageGenerationPayload,
  ScriptAnalysisPayload,
  VideoGenerationPayload,
} from "@/lib/qstash/types";

// Request schema for job creation
const createJobRequestSchema = z.object({
  type: z.literal("image").or(z.literal("video")).or(z.literal("script")),
  data: z.record(z.string(), z.unknown()),
  userId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  delay: z.number().min(0).max(86400).optional(), // Max 24 hours delay
});

type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

interface CreateJobResponse {
  success: boolean;
  jobId: string;
  status: string;
  messageId: string;
  message: string;
  timestamp: string;
  estimatedProcessingTime?: string;
}

/**
 * POST handler for creating new jobs
 */
export async function POST(request: NextRequest) {
  try {
    console.log("[JobCreate] Received job creation request", {
      url: request.url,
      method: request.method,
    });

    // Parse and validate request body
    let requestBody: CreateJobRequest;
    try {
      const body = await request.json();
      requestBody = createJobRequestSchema.parse(body);
    } catch (error) {
      console.error("[JobCreate] Invalid request body", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      if (error instanceof z.ZodError) {
        throw new ValidationError("Invalid job creation request", {
          validationErrors: error.issues,
        });
      }

      if (error instanceof SyntaxError) {
        throw new ValidationError("Invalid JSON in request body", {
          syntaxError: error.message,
        });
      }

      throw error;
    }

    const { type, data, userId, teamId, delay } = requestBody;

    console.log("[JobCreate] Creating job", {
      type,
      hasData: !!data,
      userId,
      teamId,
      delay,
    });

    // Initialize services
    const jobManager = getJobManager();
    const qstashClient = getQStashClient();

    // Create job record in database
    const job = await jobManager.createJob({
      type,
      payload: data,
      userId,
      teamId,
    });

    console.log("[JobCreate] Job record created", {
      jobId: job.id,
      status: job.status,
      createdAt: job.created_at,
    });

    // Publish job to QStash
    let qstashResponse: { messageId: string; deduplicated?: boolean };
    try {
      switch (type) {
        case JobType.IMAGE:
          qstashResponse = await qstashClient.publishImageJob(
            {
              jobId: job.id,
              type: "image" as const,
              data: data as ImageGenerationPayload["data"], // Type will be validated by publishImageJob
              userId,
              teamId,
            },
            {
              delay: delay ? delay * 1000 : undefined, // Convert to milliseconds
              deduplicationId: job.id,
            },
          );
          break;

        case JobType.VIDEO:
          qstashResponse = await qstashClient.publishVideoJob(
            {
              jobId: job.id,
              type: "video" as const,
              data: data as VideoGenerationPayload["data"], // Type will be validated by publishVideoJob
              userId,
              teamId,
            },
            {
              delay: delay ? delay * 1000 : undefined,
              deduplicationId: job.id,
            },
          );
          break;

        case JobType.SCRIPT:
          qstashResponse = await qstashClient.publishScriptJob(
            {
              jobId: job.id,
              type: "script" as const,
              data: data as ScriptAnalysisPayload["data"], // Type will be validated by publishScriptJob
              userId,
              teamId,
            },
            {
              delay: delay ? delay * 1000 : undefined,
              deduplicationId: job.id,
            },
          );
          break;

        default:
          throw new ValidationError(`Unsupported job type: ${type}`);
      }

      console.log("[JobCreate] Job published to QStash", {
        jobId: job.id,
        messageId: qstashResponse.messageId,
        deduplicated: qstashResponse.deduplicated,
      });
    } catch (publishError) {
      console.error("[JobCreate] Failed to publish job to QStash", {
        jobId: job.id,
        error:
          publishError instanceof Error
            ? publishError.message
            : "Unknown error",
      });

      // Mark job as failed since we couldn't publish it
      try {
        await jobManager.failJob(
          job.id,
          publishError instanceof Error
            ? `Failed to publish to QStash: ${publishError.message}`
            : "Failed to publish to QStash: Unknown error",
        );
      } catch (updateError) {
        console.error("[JobCreate] Failed to update job status", {
          jobId: job.id,
          updateError:
            updateError instanceof Error
              ? updateError.message
              : "Unknown error",
        });
      }

      throw publishError;
    }

    // Estimate processing time based on job type
    const estimatedProcessingTime = getEstimatedProcessingTime(type);

    const response: CreateJobResponse = {
      success: true,
      jobId: job.id,
      status: job.status,
      messageId: qstashResponse.messageId,
      message: `${type} job created and queued for processing`,
      timestamp: new Date().toISOString(),
      estimatedProcessingTime,
    };

    console.log("[JobCreate] Job creation completed successfully", {
      jobId: job.id,
      messageId: qstashResponse.messageId,
      estimatedProcessingTime,
    });

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("[JobCreate] Job creation failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const handledError = handleApiError(error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to create job",
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
export async function GET() {
  return NextResponse.json({
    message: "Job creation endpoint",
    supportedJobTypes: [JobType.IMAGE, JobType.VIDEO, JobType.SCRIPT],
    usage: {
      method: "POST",
      body: {
        type: "string (image|video|script)",
        data: "object (job-specific parameters)",
        userId: "string (optional UUID)",
        teamId: "string (optional UUID)",
        delay: "number (optional, seconds, max 86400)",
      },
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get estimated processing time for different job types
 */
function getEstimatedProcessingTime(type: string): string {
  switch (type) {
    case JobType.IMAGE:
      return "1-5 minutes";
    case JobType.VIDEO:
      return "5-15 minutes";
    case JobType.SCRIPT:
      return "1-3 minutes";
    default:
      return "Unknown";
  }
}
