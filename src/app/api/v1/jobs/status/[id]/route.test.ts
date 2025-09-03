/**
 * Unit tests for job status endpoint
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";
import {
  createMockJobManager,
  createTestJobRow,
  setupBunMocks,
  testUUIDs,
} from "@/lib/qstash/test-utils";
import { GET, OPTIONS } from "./route";

// Mock dependencies
mock.module("@/lib/qstash/job-manager", () => ({
  getJobManager: mock(() => {}),
}));

mock.module("next/server", () => ({
  NextResponse: {
    json: mock((data, options) => ({
      ok: true,
      status: options?.status || 200,
      json: () => Promise.resolve(data),
      ...data,
    })),
  },
}));

import { NextResponse } from "next/server";
// Import mocked function
import { getJobManager } from "@/lib/qstash/job-manager";

describe.skip("Job Status API", () => {
  let mockJobManager: ReturnType<typeof createMockJobManager>;
  let testSetup: ReturnType<typeof setupBunMocks>;

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockJobManager = createMockJobManager();
    (getJobManager as any).mockReturnValue(mockJobManager);
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("GET /api/v1/jobs/status/[id]", () => {
    it("should get job status successfully", async () => {
      const job = createTestJobRow({
        id: testUUIDs.job1,
        type: "image",
        status: "completed",
        result: { imageUrl: "https://example.com/image.jpg" },
      });

      mockJobManager.getJob.mockResolvedValue(job);

      const request = {
        url: `https://example.com/api/v1/jobs/status/${testUUIDs.job1}`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: testUUIDs.job1 }),
      });

      expect(mockJobManager.getJob).toHaveBeenCalledWith(testUUIDs.job1, false);
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          job: expect.objectContaining({
            id: testUUIDs.job1,
            type: "image",
            status: "completed",
          }),
          message: "Job status retrieved successfully",
        }),
      );
    });

    it("should include events when requested", async () => {
      const job = createTestJobRow({
        id: testUUIDs.job1,
      });
      const jobWithEvents = {
        ...job,
        events: [
          {
            id: testUUIDs.event1,
            event: "job.started",
            data: { timestamp: "2024-01-01T00:00:00Z" },
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
      };

      mockJobManager.getJob.mockResolvedValue(jobWithEvents);

      const request = {
        url: `https://example.com/api/v1/jobs/status/${testUUIDs.job1}?includeEvents=true`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: testUUIDs.job1 }),
      });

      expect(mockJobManager.getJob).toHaveBeenCalledWith(testUUIDs.job1, true);
      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          job: expect.objectContaining({
            events: expect.arrayContaining([
              expect.objectContaining({
                id: testUUIDs.event1,
                event: "job.started",
              }),
            ]),
          }),
        }),
      );
    });

    it("should exclude result when requested", async () => {
      const job = createTestJobRow({
        id: testUUIDs.job1,
        result: { large: "data" },
      });

      mockJobManager.getJob.mockResolvedValue(job);

      const request = {
        url: `https://example.com/api/v1/jobs/status/${testUUIDs.job1}?includeResult=false`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: testUUIDs.job1 }),
      });

      const responseData = (NextResponse.json as any).mock.calls[0][0];
      expect(responseData.job.result).toBeUndefined();
    });

    it("should return 404 for non-existent job", async () => {
      mockJobManager.getJob.mockResolvedValue(null);

      const request = {
        url: `https://example.com/api/v1/jobs/status/non-existent`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: "non-existent" }),
      });

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to get job status",
          error: expect.objectContaining({
            code: "JOB_NOT_FOUND",
          }),
        }),
        { status: 404 },
      );
    });

    it("should handle invalid job ID", async () => {
      const request = {
        url: `https://example.com/api/v1/jobs/status/`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: "" }),
      });

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to get job status",
          error: expect.objectContaining({
            code: "VALIDATION_ERROR",
          }),
        }),
        { status: 400 },
      );
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database connection failed");
      mockJobManager.getJob.mockRejectedValue(dbError);

      const request = {
        url: `https://example.com/api/v1/jobs/status/${testUUIDs.job1}`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: testUUIDs.job1 }),
      });

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Failed to get job status",
        }),
        { status: 500 },
      );
    });

    it("should handle job with all status fields", async () => {
      const job = createTestJobRow({
        id: testUUIDs.job1,
        status: "failed",
        error: "Processing failed",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:05:00Z",
      });

      mockJobManager.getJob.mockResolvedValue(job);

      const request = {
        url: `https://example.com/api/v1/jobs/status/${testUUIDs.job1}`,
      } as NextRequest;

      const _response = await GET(request, {
        params: Promise.resolve({ id: testUUIDs.job1 }),
      });

      expect(NextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          job: expect.objectContaining({
            status: "failed",
            error: "Processing failed",
            startedAt: "2024-01-01T00:00:00Z",
            completedAt: "2024-01-01T00:05:00Z",
          }),
        }),
      );
    });
  });

  describe("OPTIONS /api/v1/jobs/status/[id]", () => {
    it("should return CORS headers", async () => {
      const _response = await OPTIONS();

      expect(NextResponse.json).toHaveBeenCalledWith(
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
    });
  });
});
