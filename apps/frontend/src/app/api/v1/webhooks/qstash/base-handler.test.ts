/**
 * Unit tests for base webhook handler
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NextResponse } from "next/server";
import { ValidationError, VelroError } from "@/lib/errors";
import type { QStashVerifiedRequest } from "@/lib/qstash/middleware";
import {
  createMockJobManager,
  createTestJobPayload,
  createTestJobRow,
  setupBunMocks,
  testUUIDs,
} from "@/lib/qstash/test-utils";
import { BaseWebhookHandler } from "./base-handler";

// Mock dependencies
mock.module("@/lib/qstash/job-manager", () => ({
  getJobManager: mock(),
}));

mock.module("next/server", () => ({
  NextResponse: {
    json: mock().mockImplementation((data, options) => ({
      ok: true,
      status: options?.status || 200,
      json: () => Promise.resolve(data),
      ...data,
    })),
  },
}));

// Import mocked function
import { getJobManager } from "@/lib/qstash/job-manager";

describe("BaseWebhookHandler", () => {
  let handler: BaseWebhookHandler;
  let mockJobManager: ReturnType<typeof createMockJobManager>;
  let testSetup: ReturnType<typeof setupBunMocks>;

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockJobManager = createMockJobManager();
    (getJobManager as any).mockReturnValue(mockJobManager as any);
    handler = new BaseWebhookHandler();
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("parseRequest", () => {
    it("should parse valid webhook request", async () => {
      const requestBody = createTestJobPayload({ type: "image" });
      const request = {
        json: mock().mockResolvedValue(requestBody),
        url: "https://example.com/webhook",
        qstashMessageId: "msg_test123",
      } as unknown as QStashVerifiedRequest;

      const result = await handler.parseRequest(request);

      expect(result).toEqual(requestBody);
    });

    it("should throw ValidationError for invalid request body", async () => {
      const invalidBody = {
        jobId: "invalid-uuid",
        type: "unknown-type",
      };
      const request = {
        json: mock().mockResolvedValue(invalidBody),
        url: "https://example.com/webhook",
      } as unknown as QStashVerifiedRequest;

      await expect(handler.parseRequest(request)).rejects.toThrow(
        ValidationError,
      );
    });

    it("should handle JSON syntax errors", async () => {
      const request = {
        json: mock().mockRejectedValue(new SyntaxError("Unexpected token")),
        url: "https://example.com/webhook",
      } as unknown as QStashVerifiedRequest;

      await expect(handler.parseRequest(request)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("processWebhook", () => {
    let mockProcessor: any;
    let request: QStashVerifiedRequest;

    beforeEach(() => {
      mockProcessor = mock();
      const requestBody = createTestJobPayload({
        jobId: testUUIDs.job1,
        type: "image",
      });
      request = {
        json: mock().mockResolvedValue(requestBody),
        url: "https://example.com/webhook",
        qstashMessageId: "msg_test123",
        qstashRetryCount: 0,
      } as unknown as QStashVerifiedRequest;
    });

    it("should process webhook successfully for pending job", async () => {
      const existingJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "pending",
      });
      const processingResult = { imageUrl: "https://example.com/image.jpg" };

      mockJobManager.getJob.mockResolvedValue(existingJob);
      mockJobManager.startJob.mockResolvedValue({
        ...existingJob,
        status: "running",
      });
      mockJobManager.completeJob.mockResolvedValue({
        ...existingJob,
        status: "completed",
        result: processingResult,
      });
      mockProcessor.mockResolvedValue(processingResult);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(mockJobManager.getJob).toHaveBeenCalledWith(testUUIDs.job1);
      expect(mockJobManager.startJob).toHaveBeenCalledWith(testUUIDs.job1);
      expect(mockJobManager.completeJob).toHaveBeenCalledWith(
        testUUIDs.job1,
        processingResult,
      );
      expect(mockProcessor).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: testUUIDs.job1,
          type: "image",
        }),
        expect.objectContaining({
          messageId: "msg_test123",
          retryCount: 0,
        }),
      );
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: "completed",
          result: processingResult,
        }),
      );
    });

    it("should skip processing for completed job", async () => {
      const completedJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "completed",
      });

      mockJobManager.getJob.mockResolvedValue(completedJob);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(mockProcessor).not.toHaveBeenCalled();
      expect(mockJobManager.startJob).not.toHaveBeenCalled();
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: "completed",
          message: "Job already completed",
        }),
      );
    });

    it("should skip processing for cancelled job", async () => {
      const cancelledJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "cancelled",
      });

      mockJobManager.getJob.mockResolvedValue(cancelledJob);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(mockProcessor).not.toHaveBeenCalled();
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: "cancelled",
          message: "Job already cancelled",
        }),
      );
    });

    it("should return 404 for non-existent job", async () => {
      mockJobManager.getJob.mockResolvedValue(null);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(mockProcessor).not.toHaveBeenCalled();
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: "not_found",
          message: "Job not found in database",
        }),
        { status: 404 },
      );
    });

    it("should handle processor errors and mark job as failed", async () => {
      const existingJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "pending",
      });
      const processingError = new Error("Processing failed");

      mockJobManager.getJob.mockResolvedValue(existingJob);
      mockJobManager.startJob.mockResolvedValue({
        ...existingJob,
        status: "running",
      });
      mockJobManager.failJob.mockResolvedValue({
        ...existingJob,
        status: "failed",
        error: processingError.message,
      });
      mockProcessor.mockRejectedValue(processingError);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(mockJobManager.failJob).toHaveBeenCalledWith(
        testUUIDs.job1,
        "Processing failed",
      );
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: "failed",
          error: "Processing failed",
        }),
        { status: 500 },
      );
    });

    it("should not start running job again", async () => {
      const runningJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "running",
      });
      const processingResult = { output: "success" };

      mockJobManager.getJob.mockResolvedValue(runningJob);
      mockJobManager.completeJob.mockResolvedValue({
        ...runningJob,
        status: "completed",
        result: processingResult,
      });
      (mockProcessor as any).mockResolvedValue(processingResult);

      await handler.processWebhook(request, mockProcessor);

      expect(mockJobManager.startJob).not.toHaveBeenCalled();
      expect(mockJobManager.completeJob).toHaveBeenCalled();
    });

    it("should handle validation errors with 200 status to prevent retries", async () => {
      const validationError = new ValidationError("Invalid data");
      const existingJob = createTestJobRow({ id: testUUIDs.job1 });

      mockJobManager.getJob.mockResolvedValue(existingJob);
      mockJobManager.startJob.mockResolvedValue({
        ...existingJob,
        status: "running",
      });
      (mockProcessor as any).mockRejectedValue(validationError);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: "failed",
        }),
        { status: 200 }, // Client errors return 200 to prevent retries
      );
    });

    it("should handle server errors with proper status for retries", async () => {
      const serverError = new VelroError("Server error", "SERVER_ERROR", 503);
      const existingJob = createTestJobRow({ id: testUUIDs.job1 });

      mockJobManager.getJob.mockResolvedValue(existingJob);
      mockJobManager.startJob.mockResolvedValue({
        ...existingJob,
        status: "running",
      });
      (mockProcessor as any).mockRejectedValue(serverError);

      const _response = await handler.processWebhook(request, mockProcessor);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: "failed",
        }),
        { status: 503 }, // Server errors maintain status for retries
      );
    });
  });

  describe("createErrorResponse", () => {
    it("should create standardized error response", () => {
      const error = new VelroError("Test error", "TEST_ERROR", 400);
      const _response = (handler as any).createErrorResponse(
        error,
        testUUIDs.job1,
      );

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          jobId: testUUIDs.job1,
          status: "error",
          message: "Test error",
          error: "Test error",
        }),
        { status: 400 },
      );
    });
  });

  describe("createSuccessResponse", () => {
    it("should create standardized success response", () => {
      const result = { output: "test" };
      const _response = (handler as any).createSuccessResponse(
        testUUIDs.job1,
        "completed",
        "Job completed",
        result,
      );

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          jobId: testUUIDs.job1,
          status: "completed",
          message: "Job completed",
          result,
        }),
      );
    });
  });
});
