/**
 * Base webhook handler for QStash webhooks
 * Provides common functionality for signature verification, request parsing, and error handling
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, ValidationError, VelroError } from "@/lib/errors";
import type { JobPayload } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";
import type { QStashVerifiedRequest } from "@/lib/qstash/middleware";

// Base webhook request schema
export const webhookRequestSchema = z.object({
  jobId: z.uuid(),
  type: z
    .literal("image")
    .or(z.literal("video"))
    .or(z.literal("script"))
    .or(z.literal("frame_generation"))
    .or(z.literal("motion")),
  data: z.record(z.string(), z.unknown()),
  userId: z.uuid().optional(),
  teamId: z.uuid().optional(),
});

export type WebhookRequest = z.infer<typeof webhookRequestSchema>;

// Base webhook response interface
export interface WebhookResponse {
  success: boolean;
  jobId: string;
  status: string;
  message: string;
  timestamp: string;
  result?: Record<string, unknown>;
  error?: string;
}

// Processing function interface
export type JobProcessor = (
  payload: JobPayload,
  metadata: {
    messageId?: string;
    retryCount?: number;
  },
) => Promise<Record<string, unknown>>;

/**
 * Base webhook handler class
 */
export class BaseWebhookHandler {
  protected jobManager = getJobManager();

  /**
   * Parse and validate incoming webhook request
   */
  async parseRequest(request: QStashVerifiedRequest): Promise<WebhookRequest> {
    try {
      const body = await request.json();

      const parsedBody = webhookRequestSchema.parse(body);

      return parsedBody;
    } catch (error) {
      console.error("[BaseWebhookHandler] Failed to parse request", {
        error: error instanceof Error ? error.message : "Unknown error",
        url: request.url,
        messageId: request.qstashMessageId,
      });

      if (error instanceof z.ZodError) {
        throw new ValidationError("Invalid webhook request format", {
          validationErrors: error.issues,
          url: request.url,
        });
      }

      if (error instanceof SyntaxError) {
        throw new ValidationError("Invalid JSON in request body", {
          syntaxError: error.message,
          url: request.url,
        });
      }

      throw new VelroError(
        "Failed to parse webhook request",
        "WEBHOOK_PARSE_ERROR",
        400,
        {
          originalError:
            error instanceof Error ? error.message : "Unknown error",
          url: request.url,
        },
      );
    }
  }

  /**
   * Process webhook request with job lifecycle management
   */
  async processWebhook(
    request: QStashVerifiedRequest,
    processor: JobProcessor,
  ): Promise<NextResponse> {
    const startTime = Date.now();
    let webhookRequest: WebhookRequest | null = null;

    try {
      // Parse the request
      webhookRequest = await this.parseRequest(request);
      const { jobId, type, data, userId, teamId } = webhookRequest;

      // Check if job exists and get current status
      const existingJob = await this.jobManager.getJob(jobId);

      if (!existingJob) {
        console.warn("[BaseWebhookHandler] Job not found in database", {
          jobId,
        });

        // Return success to prevent QStash retries for non-existent jobs
        return NextResponse.json(
          {
            success: false,
            jobId,
            status: "not_found",
            message: "Job not found in database",
            timestamp: new Date().toISOString(),
          },
          { status: 404 },
        );
      }

      // Skip processing if job is already completed or cancelled
      if (
        existingJob.status === "completed" ||
        existingJob.status === "cancelled"
      ) {
        return NextResponse.json({
          success: true,
          jobId,
          status: existingJob.status,
          message: `Job already ${existingJob.status}`,
          timestamp: new Date().toISOString(),
        });
      }

      // Mark job as running if it's still pending
      if (existingJob.status === "pending") {
        await this.jobManager.startJob(jobId);
      }

      // Prepare job payload - cast to any to allow flexible data types
      // The actual type checking happens in the processor function
      const jobPayload = {
        jobId,
        type,
        data,
        userId,
        teamId,
      } as JobPayload;

      // Process the job
      const result = await processor(jobPayload, {
        messageId: request.qstashMessageId,
        retryCount: request.qstashRetryCount,
      });

      // Mark job as completed
      await this.jobManager.completeJob(jobId, result);

      const response: WebhookResponse = {
        success: true,
        jobId,
        status: "completed",
        message: "Job completed successfully",
        timestamp: new Date().toISOString(),
        result,
      };

      return NextResponse.json(response);
    } catch (error) {
      const processingTime = Date.now() - startTime;

      console.error("[BaseWebhookHandler] Job processing failed", {
        jobId: webhookRequest?.jobId,
        type: webhookRequest?.type,
        error: error instanceof Error ? error.message : "Unknown error",
        processingTimeMs: processingTime,
        messageId: request.qstashMessageId,
        retryCount: request.qstashRetryCount,
      });

      // Mark job as failed if we have a job ID
      if (webhookRequest?.jobId) {
        try {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          await this.jobManager.failJob(webhookRequest.jobId, errorMessage);
        } catch (updateError) {
          console.error(
            "[BaseWebhookHandler] Failed to update job status to failed",
            {
              jobId: webhookRequest.jobId,
              updateError:
                updateError instanceof Error
                  ? updateError.message
                  : "Unknown error",
            },
          );
        }
      }

      // Handle the error and return appropriate response
      const handledError = handleApiError(error);

      const response: WebhookResponse = {
        success: false,
        jobId: webhookRequest?.jobId || "unknown",
        status: "failed",
        message: handledError.message,
        timestamp: new Date().toISOString(),
        error: handledError.message,
      };

      // Return 200 for validation errors to prevent QStash retries
      // Return 500 for processing errors to allow retries
      const statusCode =
        handledError.statusCode >= 400 && handledError.statusCode < 500
          ? 200 // Client errors - don't retry
          : handledError.statusCode; // Server errors - allow retry

      return NextResponse.json(response, { status: statusCode });
    }
  }

  /**
   * Create a standardized error response
   */
  protected createErrorResponse(
    error: VelroError,
    jobId?: string,
  ): NextResponse {
    const response: WebhookResponse = {
      success: false,
      jobId: jobId || "unknown",
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
      error: error.message,
    };

    return NextResponse.json(response, { status: error.statusCode });
  }

  /**
   * Create a standardized success response
   */
  protected createSuccessResponse(
    jobId: string,
    status: string,
    message: string,
    result?: Record<string, unknown>,
  ): NextResponse {
    const response: WebhookResponse = {
      success: true,
      jobId,
      status,
      message,
      timestamp: new Date().toISOString(),
      result,
    };

    return NextResponse.json(response);
  }
}
