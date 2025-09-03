/**
 * Unit tests for job creation API endpoint
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";
import { VelroError } from "@/lib/errors";
import {
  createMockJobManager,
  createMockNextRequest,
  createMockQStashClient,
  createTestJobRow,
  setupBunMocks,
  testUUIDs,
} from "@/lib/qstash/test-utils";
import { GET, POST } from "./route";

// Mock dependencies
mock.module("@/lib/qstash/client", () => ({
  getQStashClient: mock(() => {}),
}));

mock.module("@/lib/qstash/job-manager", () => ({
  getJobManager: mock(() => {}),
  JobType: {
    IMAGE: "image",
    VIDEO: "video",
    SCRIPT: "script",
  },
}));

import { NextResponse } from "next/server";
// Import mocked functions
import { getQStashClient } from "@/lib/qstash/client";
import { getJobManager } from "@/lib/qstash/job-manager";

mock.module("next/server", () => ({
  NextResponse: {
    json: mock((data, options) => ({
      ok: true,
      status: options?.status || 200,
      json: () => Promise.resolve(data),
    })),
  },
}));

describe.skip("Job Creation API", () => {
  let mockQStashClient: ReturnType<typeof createMockQStashClient>;
  let mockJobManager: ReturnType<typeof createMockJobManager>;
  let testSetup: ReturnType<typeof setupBunMocks>;

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockQStashClient = createMockQStashClient();
    mockJobManager = createMockJobManager();

    (getQStashClient as any).mockReturnValue(mockQStashClient);
    (getJobManager as any).mockReturnValue(mockJobManager);
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("POST /api/v1/jobs/create", () => {
    it("should create an image job successfully", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job1,
        type: "image",
        status: "pending",
      });

      mockJobManager.createJob.mockResolvedValue(newJob);

      const requestBody = {
        type: "image",
        data: {
          prompt: "A beautiful landscape",
          style: "photographic",
          width: 1024,
          height: 1024,
        },
        userId: testUUIDs.user1,
        teamId: testUUIDs.team1,
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.createJob).toHaveBeenCalledWith({
        type: "image",
        payload: requestBody.data,
        userId: testUUIDs.user1,
        teamId: testUUIDs.team1,
      });

      expect(mockQStashClient.publishImageJob).toHaveBeenCalledWith(
        {
          jobId: newJob.id,
          type: "image",
          data: requestBody.data,
          userId: testUUIDs.user1,
          teamId: testUUIDs.team1,
        },
        {
          delay: undefined,
          deduplicationId: newJob.id,
        },
      );

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          jobId: newJob.id,
          status: "pending",
          messageId: "msg_image123456789",
          message: "image job created and queued for processing",
          estimatedProcessingTime: "1-5 minutes",
        }),
        { status: 201 },
      );
    });

    it("should create a video job with delay", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job2,
        type: "video",
        status: "pending",
      });

      mockJobManager.createJob.mockResolvedValue(newJob);

      const requestBody = {
        type: "video",
        data: {
          prompt: "A scenic mountain view",
          duration: 5,
        },
        delay: 3600, // 1 hour delay
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockQStashClient.publishVideoJob).toHaveBeenCalledWith(
        expect.any(Object),
        {
          delay: 3600000, // Converted to milliseconds
          deduplicationId: newJob.id,
        },
      );
    });

    it("should create a script job successfully", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job1,
        type: "script",
        status: "pending",
      });

      mockJobManager.createJob.mockResolvedValue(newJob);

      const requestBody = {
        type: "script",
        data: {
          script: "FADE IN: EXT. MOUNTAIN VALLEY - DAY",
          genre: "adventure",
          language: "en",
        },
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockQStashClient.publishScriptJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "script",
          data: requestBody.data,
        }),
        expect.any(Object),
      );
    });

    it("should handle invalid request body", async () => {
      const requestBody = {
        type: "invalid-type",
        data: {},
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.createJob).not.toHaveBeenCalled();
      expect(mockQStashClient.publishImageJob).not.toHaveBeenCalled();

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to create job",
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
          }),
        }),
        { status: 400 },
      );
    });

    it("should handle malformed JSON", async () => {
      const request = {
        json: mock().mockRejectedValue(new SyntaxError("Unexpected token")),
        url: "https://example.com/api/v1/jobs/create",
        method: "POST",
      };

      const _response = await POST(request as unknown as NextRequest);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to create job",
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
          }),
        }),
        { status: 400 },
      );
    });

    it("should handle job manager errors", async () => {
      const jobManagerError = new Error("Database connection failed");
      mockJobManager.createJob.mockRejectedValue(jobManagerError);

      const requestBody = {
        type: "image",
        data: { prompt: "Test prompt" },
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to create job",
        }),
        { status: 500 },
      );
    });

    it("should handle QStash publishing errors", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job1,
        type: "image",
        status: "pending",
      });

      mockJobManager.createJob.mockResolvedValue(newJob);
      mockJobManager.failJob.mockResolvedValue(newJob);

      const qstashError = new VelroError(
        "QStash service unavailable",
        "QSTASH_PUBLISH_ERROR",
        503,
      );
      mockQStashClient.publishImageJob.mockRejectedValue(qstashError);

      const requestBody = {
        type: "image",
        data: { prompt: "Test prompt" },
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.failJob).toHaveBeenCalledWith(
        newJob.id,
        "Failed to publish to QStash: QStash service unavailable",
      );

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to create job",
        }),
        { status: 503 },
      );
    });

    it("should validate delay parameter", async () => {
      const requestBody = {
        type: "image",
        data: { prompt: "Test prompt" },
        delay: 90000, // More than max 86400 seconds
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.createJob).not.toHaveBeenCalled();

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
          }),
        }),
        { status: 400 },
      );
    });

    it("should validate UUID fields", async () => {
      const requestBody = {
        type: "image",
        data: { prompt: "Test prompt" },
        userId: "invalid-uuid",
        teamId: "also-invalid-uuid",
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.createJob).not.toHaveBeenCalled();

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
          }),
        }),
        { status: 400 },
      );
    });

    it("should work with minimal required fields", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job1,
        type: "image",
        user_id: null,
        team_id: null,
      });

      mockJobManager.createJob.mockResolvedValue(newJob);

      const requestBody = {
        type: "image",
        data: { prompt: "Minimal test" },
      };

      const request = createMockNextRequest({
        method: "POST",
        body: requestBody,
      });

      const _response = await POST(request as unknown as NextRequest);

      expect(mockJobManager.createJob).toHaveBeenCalledWith({
        type: "image",
        payload: { prompt: "Minimal test" },
        userId: undefined,
        teamId: undefined,
      });

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          jobId: newJob.id,
        }),
        { status: 201 },
      );
    });
  });

  describe("GET /api/v1/jobs/create", () => {
    it("should return endpoint information", async () => {
      const _response = await GET();

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Job creation endpoint",
          supportedJobTypes: ["image", "video", "script"],
          usage: expect.objectContaining({
            method: "POST",
            body: expect.objectContaining({
              type: "string (image|video|script)",
              data: "object (job-specific parameters)",
            }),
          }),
          timestamp: expect.any(String),
        }),
      );
    });
  });
});
