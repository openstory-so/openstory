/**
 * Unit tests for job management service
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseError, ValidationError } from "@/lib/errors";
import { getJobManager, JobManager, JobStatus, JobType } from "./job-manager";
import {
  createMockSupabaseClient,
  createTestDate,
  createTestJobRow,
  setupBunMocks,
  testUUIDs,
} from "./test-utils";

// Mock the Supabase server module
mock.module("@/lib/supabase/server", () => ({
  createAdminClient: mock(),
}));

// Import the mocked module
import { createAdminClient } from "@/lib/supabase/server";

describe.skip("JobManager", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let jobManager: JobManager;
  let testSetup: ReturnType<typeof setupBunMocks>;

  const setupMockChainResponse = (mockData: { data: any; error: any }) => {
    const chain = (mockSupabase as any).from("jobs");
    // biome-ignore lint/suspicious/noThenProperty: Required for thenable mock
    chain.then = mock((onResolve) => {
      return Promise.resolve(mockData).then(onResolve);
    });
  };

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockSupabase = createMockSupabaseClient();

    (createAdminClient as any).mockReturnValue(mockSupabase as any);

    jobManager = new JobManager();

    // Reset the chain's then method to default behavior for each test
    setupMockChainResponse({ data: [], error: null });
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  describe("createJob", () => {
    it("should create a job successfully", async () => {
      const newJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "pending",
        created_at: createTestDate(),
        updated_at: createTestDate(),
      });

      setupMockChainResponse({ data: newJob, error: null });

      const result = await jobManager.createJob({
        type: "image",
        payload: { prompt: "Test prompt" },
        userId: testUUIDs.user1,
        teamId: testUUIDs.team1,
      });

      expect(mockSupabase.from).toHaveBeenCalledWith("jobs");
      expect(mockSupabase.mockHelpers.mockInsert).toHaveBeenCalled();
      expect(mockSupabase.mockHelpers.mockSelect).toHaveBeenCalled();
      expect(mockSupabase.mockHelpers.mockSingle).toHaveBeenCalled();
      expect(result).toEqual(newJob);
    });

    it("should handle validation errors", async () => {
      await expect(
        jobManager.createJob({
          type: "invalid" as any,
          payload: { prompt: "Test prompt" },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("should handle database errors", async () => {
      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: null,
        error: {
          message: "Database connection failed",
          code: "CONNECTION_ERROR",
        },
      });

      await expect(
        jobManager.createJob({
          type: "image",
          payload: { prompt: "Test prompt" },
        }),
      ).rejects.toThrow(DatabaseError);
    });

    it("should create job with minimal required fields", async () => {
      const newJob = createTestJobRow({
        user_id: null,
        team_id: null,
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: newJob,
        error: null,
      });

      const result = await jobManager.createJob({
        type: "video",
        payload: { script: "Test script" },
      });

      expect(result.user_id).toBeNull();
      expect(result.team_id).toBeNull();
    });
  });

  describe("getJob", () => {
    it("should get a job by ID successfully", async () => {
      const existingJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "completed",
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: existingJob,
        error: null,
      });

      const result = await jobManager.getJob(testUUIDs.job1);

      expect(mockSupabase.from).toHaveBeenCalledWith("jobs");
      expect(mockSupabase.mockHelpers.mockSelect).toHaveBeenCalledWith("*");
      expect(mockSupabase.mockHelpers.mockEq).toHaveBeenCalledWith(
        "id",
        testUUIDs.job1,
      );
      expect(result).toEqual(existingJob);
    });

    it("should return null for non-existent job", async () => {
      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: null,
        error: { code: "PGRST116", message: "No rows returned" },
      });

      const result = await jobManager.getJob("non-existent-id");

      expect(result).toBeNull();
    });

    it("should handle database errors", async () => {
      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: null,
        error: {
          message: "Database connection failed",
          code: "CONNECTION_ERROR",
        },
      });

      await expect(jobManager.getJob(testUUIDs.job1)).rejects.toThrow(
        DatabaseError,
      );
    });

    it("should include events when requested", async () => {
      const existingJob = createTestJobRow();

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: existingJob,
        error: null,
      });

      const result = await jobManager.getJob(testUUIDs.job1, true);

      expect(result?.events).toEqual([]);
    });
  });

  describe("updateJob", () => {
    it("should update job successfully", async () => {
      const updatedJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "completed",
        result: { imageUrl: "https://example.com/image.png" },
        completed_at: createTestDate(10),
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: updatedJob,
        error: null,
      });

      const result = await jobManager.updateJob(testUUIDs.job1, {
        status: "completed",
        result: { imageUrl: "https://example.com/image.png" },
        completedAt: createTestDate(10),
      });

      expect(mockSupabase.mockHelpers.mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "completed",
          result: { imageUrl: "https://example.com/image.png" },
          completed_at: createTestDate(10),
          updated_at: expect.any(String),
        }),
      );
      expect(result).toEqual(updatedJob);
    });

    it("should handle validation errors in update", async () => {
      await expect(
        jobManager.updateJob(testUUIDs.job1, {
          status: "invalid" as any,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("should handle database errors in update", async () => {
      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: null,
        error: {
          message: "Job not found",
          code: "NOT_FOUND",
        },
      });

      await expect(
        jobManager.updateJob(testUUIDs.job1, {
          status: "completed",
        }),
      ).rejects.toThrow(DatabaseError);
    });
  });

  describe("cancelJob", () => {
    it("should cancel a job successfully", async () => {
      const cancelledJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "cancelled",
        completed_at: createTestDate(5),
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: cancelledJob,
        error: null,
      });

      const result = await jobManager.cancelJob(testUUIDs.job1);

      expect(result.status).toBe("cancelled");
      expect(result.completed_at).toBeTruthy();
    });
  });

  describe("startJob", () => {
    it("should start a job successfully", async () => {
      const startedJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "running",
        started_at: createTestDate(2),
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: startedJob,
        error: null,
      });

      const result = await jobManager.startJob(testUUIDs.job1);

      expect(result.status).toBe("running");
      expect(result.started_at).toBeTruthy();
    });
  });

  describe("completeJob", () => {
    it("should complete a job with result", async () => {
      const completedJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "completed",
        result: { output: "success" },
        completed_at: createTestDate(10),
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: completedJob,
        error: null,
      });

      const result = await jobManager.completeJob(testUUIDs.job1, {
        output: "success",
      });

      expect(result.status).toBe("completed");
      expect(result.result).toEqual({ output: "success" });
      expect(result.completed_at).toBeTruthy();
    });
  });

  describe("failJob", () => {
    it("should fail a job with error message", async () => {
      const failedJob = createTestJobRow({
        id: testUUIDs.job1,
        status: "failed",
        error: "Processing timeout",
        completed_at: createTestDate(8),
      });

      mockSupabase.mockHelpers.mockSingle.mockResolvedValue({
        data: failedJob,
        error: null,
      });

      const result = await jobManager.failJob(
        testUUIDs.job1,
        "Processing timeout",
      );

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Processing timeout");
      expect(result.completed_at).toBeTruthy();
    });
  });

  describe("getJobsByStatus", () => {
    it("should get jobs by status with default options", async () => {
      const jobs = [
        createTestJobRow({ id: testUUIDs.job1, status: "pending" }),
        createTestJobRow({ id: testUUIDs.job2, status: "pending" }),
      ];

      mockSupabase.mockHelpers.mockOrder.mockResolvedValue({
        data: jobs,
        error: null,
      });

      const result = await jobManager.getJobsByStatus("pending");

      expect(mockSupabase.mockHelpers.mockEq).toHaveBeenCalledWith(
        "status",
        "pending",
      );
      expect(mockSupabase.mockHelpers.mockOrder).toHaveBeenCalledWith(
        "created_at",
        {
          ascending: false,
        },
      );
      expect(result).toEqual(jobs);
    });

    it("should get jobs with pagination", async () => {
      const jobs = [createTestJobRow({ status: "running" })];

      mockSupabase.mockHelpers.mockRange.mockResolvedValue({
        data: jobs,
        error: null,
      });

      const result = await jobManager.getJobsByStatus("running", {
        limit: 10,
        offset: 20,
      });

      expect(mockSupabase.mockHelpers.mockLimit).toHaveBeenCalledWith(10);
      expect(mockSupabase.mockHelpers.mockRange).toHaveBeenCalledWith(20, 29);
      expect(result).toEqual(jobs);
    });

    it("should filter by team and user", async () => {
      const jobs = [
        createTestJobRow({
          status: "completed",
          team_id: testUUIDs.team1,
          user_id: testUUIDs.user1,
        }),
      ];

      // Get the chain and override its 'then' method to return our test data
      const chain = (mockSupabase as any).from("jobs");
      // biome-ignore lint/suspicious/noThenProperty: Required for thenable mock
      chain.then = mock((onResolve) => {
        return Promise.resolve({ data: jobs, error: null }).then(onResolve);
      });

      const result = await jobManager.getJobsByStatus("completed", {
        teamId: testUUIDs.team1,
        userId: testUUIDs.user1,
      });

      expect(mockSupabase.mockHelpers.mockEq).toHaveBeenCalledWith(
        "status",
        "completed",
      );
      expect(mockSupabase.mockHelpers.mockEq).toHaveBeenCalledWith(
        "team_id",
        testUUIDs.team1,
      );
      expect(mockSupabase.mockHelpers.mockEq).toHaveBeenCalledWith(
        "user_id",
        testUUIDs.user1,
      );
      expect(result).toEqual(jobs);
    });

    it("should handle database errors in status query", async () => {
      mockSupabase.mockHelpers.mockOrder.mockResolvedValue({
        data: null,
        error: {
          message: "Query failed",
          code: "QUERY_ERROR",
        },
      });

      await expect(jobManager.getJobsByStatus("pending")).rejects.toThrow(
        DatabaseError,
      );
    });
  });

  describe("singleton pattern", () => {
    it("should return the same instance on multiple calls", () => {
      const manager1 = getJobManager();
      const manager2 = getJobManager();

      expect(manager1).toBe(manager2);
    });
  });

  describe("job status constants", () => {
    it("should have correct job status values", () => {
      expect(JobStatus.PENDING).toBe("pending");
      expect(JobStatus.RUNNING).toBe("running");
      expect(JobStatus.COMPLETED).toBe("completed");
      expect(JobStatus.FAILED).toBe("failed");
      expect(JobStatus.CANCELLED).toBe("cancelled");
    });
  });

  describe("job type constants", () => {
    it("should have correct job type values", () => {
      expect(JobType.IMAGE).toBe("image");
      expect(JobType.VIDEO).toBe("video");
      expect(JobType.SCRIPT).toBe("script");
    });
  });
});
