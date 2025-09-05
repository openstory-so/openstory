/**
 * Tests for motion generation webhook handler
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { QStashVerifiedRequest } from "@/lib/qstash/middleware";
import {
  createMockJobManager,
  createMockSupabaseClient,
  setupBunMocks,
  testUUIDs,
} from "@/lib/qstash/test-utils";
import type { MotionGenerationPayload } from "@/lib/qstash/types";

// Mock dependencies
mock.module("@/lib/qstash/job-manager", () => ({
  getJobManager: mock(),
}));

mock.module("@/lib/supabase/server", () => ({
  createAdminClient: mock(),
}));

mock.module("@/lib/qstash/middleware", () => ({
  withQStashVerification: (handler: any) => handler,
}));

mock.module("@/lib/services/motion.service", () => ({
  generateMotionForFrame: mock(),
}));

mock.module("@/lib/services/video-storage.service", () => ({
  uploadVideoToStorage: mock(),
}));

describe("Motion Generation Webhook", () => {
  let testSetup: ReturnType<typeof setupBunMocks>;
  let mockJobManager: ReturnType<typeof createMockJobManager>;
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;

  beforeEach(() => {
    testSetup = setupBunMocks();
    mockJobManager = createMockJobManager();
    mockSupabase = createMockSupabaseClient() as any;
    mock.clearAllMocks();
  });

  afterEach(() => {
    testSetup.restoreConsole();
    testSetup.cleanupEnv();
    mock.restore();
  });

  it("should process motion generation successfully", async () => {
    // Setup mocks
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { createAdminClient } = await import("@/lib/supabase/server");
    const { generateMotionForFrame } = await import(
      "@/lib/services/motion.service"
    );
    const { uploadVideoToStorage } = await import(
      "@/lib/services/video-storage.service"
    );

    (getJobManager as any).mockReturnValue(mockJobManager);
    (createAdminClient as any).mockReturnValue(mockSupabase);

    // Mock job exists
    mockJobManager.getJob.mockResolvedValue({
      id: testUUIDs.job1,
      type: "motion",
      status: "running",
      team_id: testUUIDs.team1,
    });

    // Mock frame data
    const mockFrame = {
      id: testUUIDs.frame1,
      thumbnail_url: "https://example.com/thumbnail.jpg",
      metadata: {},
      sequences: {
        team_id: testUUIDs.team1,
        style_id: testUUIDs.style1,
        styles: {
          config: {
            genre: "action",
            mood: "exciting",
          },
        },
      },
    };

    mockSupabase.from.mockReturnValue({
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: mockFrame,
            error: null,
          }),
        }),
      }),
      update: mock().mockReturnValue({
        eq: mock().mockResolvedValue({
          error: null,
        }),
      }),
    } as any);

    // Mock motion generation
    (generateMotionForFrame as any).mockResolvedValue({
      success: true,
      videoUrl: "https://fal.ai/video.mp4",
      metadata: {
        model: "fal-ai/fast-svd-lcm",
        duration: 2,
        fps: 7,
      },
    });

    // Mock video upload
    (uploadVideoToStorage as any).mockResolvedValue({
      success: true,
      url: "https://supabase.co/storage/video.mp4",
      path: "teams/team1/sequences/seq1/frames/frame1/motion.mp4",
    });

    // Create request
    const payload: MotionGenerationPayload = {
      jobId: testUUIDs.job1,
      type: "motion",
      data: {
        frameId: testUUIDs.frame1,
        sequenceId: testUUIDs.sequence1,
        thumbnailUrl: "https://example.com/thumbnail.jpg",
        model: "svd-lcm",
        duration: 2,
        fps: 7,
      },
    };

    const request = {
      json: mock().mockResolvedValue(payload),
      url: "https://example.com/webhook",
      qstashMessageId: "msg_test123",
      qstashRetryCount: 0,
    } as unknown as QStashVerifiedRequest;

    // Import and call the handler
    const { POST } = await import("./route");
    const response = await POST(request);
    const responseData = await response.json();

    // Verify response
    expect(responseData.status).toBe("completed");
    expect(responseData.success).toBe(true);
    expect(responseData.jobId).toBe(testUUIDs.job1);

    // Verify motion generation was called
    expect(generateMotionForFrame).toHaveBeenCalledWith({
      imageUrl: "https://example.com/thumbnail.jpg",
      model: "svd-lcm",
      duration: 2,
      fps: 7,
      motionBucket: 127,
      prompt: undefined,
      styleStack: {
        genre: "action",
        mood: "exciting",
      },
    });

    // Verify video upload was called
    expect(uploadVideoToStorage).toHaveBeenCalledWith({
      videoUrl: "https://fal.ai/video.mp4",
      teamId: testUUIDs.team1,
      sequenceId: testUUIDs.sequence1,
      frameId: testUUIDs.frame1,
    });

    // Verify frame was updated with video URL
    const updateCall = mockSupabase.from.mock.calls.find(
      (call: any) => call[0] === "frames",
    );
    expect(updateCall).toBeDefined();
  });

  it("should handle motion generation failure", async () => {
    // Setup mocks
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { createAdminClient } = await import("@/lib/supabase/server");
    const { generateMotionForFrame } = await import(
      "@/lib/services/motion.service"
    );

    (getJobManager as any).mockReturnValue(mockJobManager);
    (createAdminClient as any).mockReturnValue(mockSupabase);

    // Mock job exists
    mockJobManager.getJob.mockResolvedValue({
      id: testUUIDs.job1,
      type: "motion",
      status: "running",
      team_id: testUUIDs.team1,
    });

    // Mock frame data
    const mockFrame = {
      id: testUUIDs.frame1,
      thumbnail_url: "https://example.com/thumbnail.jpg",
      metadata: {},
      sequences: {
        team_id: testUUIDs.team1,
        style_id: null,
        styles: null,
      },
    };

    mockSupabase.from.mockReturnValue({
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: mockFrame,
            error: null,
          }),
        }),
      }),
      update: mock().mockReturnValue({
        eq: mock().mockResolvedValue({
          error: null,
        }),
      }),
    } as any);

    // Mock motion generation failure
    (generateMotionForFrame as any).mockResolvedValue({
      success: false,
      error: "Motion generation API error",
    });

    // Create request
    const payload: MotionGenerationPayload = {
      jobId: testUUIDs.job1,
      type: "motion",
      data: {
        frameId: testUUIDs.frame1,
        sequenceId: testUUIDs.sequence1,
        thumbnailUrl: "https://example.com/thumbnail.jpg",
      },
    };

    const request = {
      json: mock().mockResolvedValue(payload),
      url: "https://example.com/webhook",
      qstashMessageId: "msg_test123",
      qstashRetryCount: 0,
    } as unknown as QStashVerifiedRequest;

    // Import and call the handler
    const { POST } = await import("./route");
    const response = await POST(request);
    const responseData = await response.json();

    // Verify error response
    expect(responseData.success).toBe(false);
    expect(responseData.status).toBe("failed");
    expect(responseData.error).toContain("Motion generation API error");

    // Verify frame metadata was updated with failure status
    const updateCalls = mockSupabase.from.mock.calls.filter(
      (call: any) => call[0] === "frames",
    );

    // Should have one call to update with failure
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it("should reject unauthorized team access", async () => {
    // Setup mocks
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { createAdminClient } = await import("@/lib/supabase/server");

    (getJobManager as any).mockReturnValue(mockJobManager);
    (createAdminClient as any).mockReturnValue(mockSupabase);

    // Mock job with different team
    mockJobManager.getJob.mockResolvedValue({
      id: testUUIDs.job1,
      type: "motion",
      status: "running",
      team_id: "different-team-id",
    });

    // Mock frame data
    mockSupabase.from.mockReturnValue({
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: {
              id: testUUIDs.frame1,
              sequences: {
                team_id: testUUIDs.team1,
              },
            },
            error: null,
          }),
        }),
      }),
    } as any);

    // Create request
    const payload: MotionGenerationPayload = {
      jobId: testUUIDs.job1,
      type: "motion",
      data: {
        frameId: testUUIDs.frame1,
        sequenceId: testUUIDs.sequence1,
        thumbnailUrl: "https://example.com/thumbnail.jpg",
      },
    };

    const request = {
      json: mock().mockResolvedValue(payload),
      url: "https://example.com/webhook",
      qstashMessageId: "msg_test123",
    } as unknown as QStashVerifiedRequest;

    // Import and call the handler
    const { POST } = await import("./route");
    const response = await POST(request);
    const responseData = await response.json();

    // Verify error response for unauthorized access
    expect(responseData.success).toBe(false);
    expect(responseData.status).toBe("failed");
    expect(responseData.error).toBe("Unauthorized: Team ID mismatch");
  });

  it("should handle missing frame", async () => {
    // Setup mocks
    const { getJobManager } = await import("@/lib/qstash/job-manager");
    const { createAdminClient } = await import("@/lib/supabase/server");

    (getJobManager as any).mockReturnValue(mockJobManager);
    (createAdminClient as any).mockReturnValue(mockSupabase);

    // Mock job exists
    mockJobManager.getJob.mockResolvedValue({
      id: testUUIDs.job1,
      type: "motion",
      status: "running",
      team_id: testUUIDs.team1,
    });

    // Mock frame not found
    mockSupabase.from.mockReturnValue({
      select: mock().mockReturnValue({
        eq: mock().mockReturnValue({
          single: mock().mockResolvedValue({
            data: null,
            error: { message: "Frame not found" },
          }),
        }),
      }),
    } as any);

    // Create request
    const payload: MotionGenerationPayload = {
      jobId: testUUIDs.job1,
      type: "motion",
      data: {
        frameId: testUUIDs.frame1,
        sequenceId: testUUIDs.sequence1,
        thumbnailUrl: "https://example.com/thumbnail.jpg",
      },
    };

    const request = {
      json: mock().mockResolvedValue(payload),
      url: "https://example.com/webhook",
      qstashMessageId: "msg_test123",
    } as unknown as QStashVerifiedRequest;

    // Import and call the handler
    const { POST } = await import("./route");
    const response = await POST(request);
    const responseData = await response.json();

    // Verify error response for missing frame
    expect(responseData.success).toBe(false);
    expect(responseData.status).toBe("failed");
    expect(responseData.error).toBe(`Frame not found: ${testUUIDs.frame1}`);
  });
});
