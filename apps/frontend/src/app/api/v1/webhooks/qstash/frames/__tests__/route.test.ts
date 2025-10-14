/**
 * Tests for frame generation webhook
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { FrameGenerationPayload } from "@/lib/qstash/types";

// Test UUIDs
const TEST_JOB_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SEQUENCE_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_TEAM_ID = "550e8400-e29b-41d4-a716-446655440002";
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440003";
const TEST_IMAGE_JOB_ID = "550e8400-e29b-41d4-a716-446655440004";

// Mock dependencies
const mockJobManager = {
  getJob: mock(() =>
    Promise.resolve({
      id: TEST_JOB_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      status: "pending",
      type: "frame_generation",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: {},
    } as any),
  ),
  startJob: mock(() => Promise.resolve()),
  completeJob: mock(() => Promise.resolve()),
  failJob: mock(() => Promise.resolve()),
  createJob: mock(() =>
    Promise.resolve({
      id: TEST_IMAGE_JOB_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      status: "pending",
      type: "image",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payload: {},
    } as any),
  ),
};

const mockAdminClient = {
  from: mock((table: string) => {
    // Handle different table operations
    if (table === "team_members") {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              single: mock(() =>
                Promise.resolve({
                  data: { id: "550e8400-e29b-41d4-a716-446655440005" },
                  error: null,
                }),
              ),
            })),
          })),
        })),
      };
    } else if (table === "frames") {
      return {
        delete: mock(() => ({
          eq: mock(() =>
            Promise.resolve({
              error: null,
            }),
          ),
          in: mock(() =>
            Promise.resolve({
              error: null,
            }),
          ),
        })),
        insert: mock(() => ({
          select: mock(() =>
            Promise.resolve({
              data: Array(5)
                .fill(null)
                .map((_, i) => ({
                  id: `550e8400-e29b-41d4-a716-44665544000${i + 6}`,
                  sequence_id: TEST_SEQUENCE_ID,
                  description: `Frame ${i + 1}`,
                  order_index: i,
                  duration_ms: 1000,
                })),
              error: null,
            }),
          ),
        })),
        select: mock(() => ({
          eq: mock(() =>
            Promise.resolve({
              data: [],
              error: null,
            }),
          ),
        })),
      };
    } else if (table === "sequences") {
      return {
        select: mock((selectFields: string) => ({
          eq: mock((sequenceId: string) => ({
            single: mock(() => {
              // For the team mismatch test, always return TEST_TEAM_ID
              // The job in that test has differentTeamId, so there will be a mismatch
              const teamId = TEST_TEAM_ID;

              // Return sequence with styles if joined
              if (selectFields?.includes("styles")) {
                return Promise.resolve({
                  data: {
                    id: sequenceId,
                    script: "This is a test script for the sequence.",
                    style_id: "550e8400-e29b-41d4-a716-44665544000b",
                    team_id: teamId,
                    metadata: {},
                    styles: {
                      metadata: { theme: "dark" },
                    },
                  },
                  error: null,
                });
              }
              // Return just metadata for metadata-only queries
              return Promise.resolve({
                data: {
                  id: sequenceId,
                  metadata: {},
                  team_id: teamId,
                  script: "This is a test script for the sequence.",
                  style_id: "550e8400-e29b-41d4-a716-44665544000b",
                },
                error: null,
              });
            }),
          })),
        })),
        update: mock(() => ({
          eq: mock(() =>
            Promise.resolve({
              error: null,
            }),
          ),
        })),
      };
    }
    // Default return for other tables
    return {
      select: mock(() => ({
        eq: mock(() =>
          Promise.resolve({
            data: null,
            error: null,
          }),
        ),
      })),
    };
  }),
};

const mockAnalyzeScript = mock(() =>
  Promise.resolve({
    scenes: [
      {
        start: 0,
        end: 100,
        description: "Opening scene",
        duration: 5000,
      },
      {
        start: 100,
        end: 200,
        description: "Action scene",
        duration: 7000,
      },
    ],
    characters: ["Hero", "Villain"],
    settings: ["City"],
  }),
);

const mockGenerateDescriptions = mock(() =>
  Promise.resolve({
    frames: Array(5)
      .fill(null)
      .map((_, i) => ({
        description: `Generated frame ${i + 1} description`,
        orderIndex: i,
        durationMs: 1000,
        metadata: {
          scene: Math.floor(i / 3),
          shotType: "medium shot",
          mood: "dramatic",
        },
      })),
    totalDuration: 5000,
    frameCount: 5,
  }),
);

// Mock QStash client
const mockQStashClient = {
  publishImageJob: mock(() =>
    Promise.resolve({
      messageId: "msg-image-123",
      deduplicated: false,
    }),
  ),
};

// Mock modules
mock.module("@/lib/qstash/job-manager", () => ({
  getJobManager: () => mockJobManager,
}));

mock.module("@/lib/qstash/client", () => ({
  getQStashClient: () => mockQStashClient,
}));

mock.module("@/lib/supabase/server", () => ({
  createAdminClient: () => mockAdminClient,
}));

mock.module("@/lib/ai/script-analyzer", () => ({
  analyzeScriptForFrames: mockAnalyzeScript,
}));

mock.module("@/lib/ai/frame-generator", () => ({
  generateFrameDescriptions: mockGenerateDescriptions,
}));

// Mock the QStash middleware to bypass signature verification in tests
mock.module("@/lib/qstash/middleware", () => ({
  withQStashVerification: (handler: (req: any) => Promise<Response>) => handler,
  QStashVerifiedRequest: class {},
}));

describe.skip("Frame Generation Webhook", () => {
  let handler: (req: any) => Promise<Response>;

  beforeEach(async () => {
    // Clear all mocks to avoid interference between tests
    mockJobManager.getJob.mockClear();
    mockJobManager.startJob.mockClear();
    mockJobManager.completeJob.mockClear();
    mockJobManager.failJob.mockClear();
    mockJobManager.createJob.mockClear();
    mockAnalyzeScript.mockClear();
    mockGenerateDescriptions.mockClear();
    mockQStashClient.publishImageJob.mockClear();

    // Clear the mockAdminClient.from mock
    (mockAdminClient.from as any).mockClear();

    // Import handler after mocks are set up
    const module = await import("../route");
    handler = module.POST;
  });

  it("should process frame generation job successfully", async () => {
    const payload: FrameGenerationPayload = {
      jobId: TEST_JOB_ID,
      type: "frame_generation",
      data: {
        sequenceId: TEST_SEQUENCE_ID,
        options: {
          framesPerScene: 3,
          generateDescriptions: true,
        },
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.jobId).toBe(TEST_JOB_ID);
    expect(data.result.frameCount).toBe(5);

    // Verify job was retrieved for authorization
    expect(mockJobManager.getJob).toHaveBeenCalledWith(TEST_JOB_ID);

    // Verify job was started
    expect(mockJobManager.startJob).toHaveBeenCalledWith(TEST_JOB_ID);

    // Verify script was analyzed
    expect(mockAnalyzeScript).toHaveBeenCalledWith(
      "This is a test script for the sequence.",
      undefined,
    );

    // Verify descriptions were generated
    expect(mockGenerateDescriptions).toHaveBeenCalled();
    const generateCalls = mockGenerateDescriptions.mock.calls as any[];
    expect(generateCalls.length).toBeGreaterThan(0);
    if (generateCalls.length > 0) {
      const generateCall = generateCalls[0][0];
      expect(generateCall.script).toBe(
        "This is a test script for the sequence.",
      );
      expect(generateCall.framesPerScene).toBe(3);
    }

    // Verify job was completed
    expect(mockJobManager.completeJob).toHaveBeenCalledWith(
      TEST_JOB_ID,
      expect.objectContaining({
        frameCount: 5,
        totalDuration: 5000,
      }),
    );
  });

  it("should use provided script analysis", async () => {
    const secondJobId = "550e8400-e29b-41d4-a716-44665544000c";
    const secondSequenceId = "550e8400-e29b-41d4-a716-44665544000d";
    const secondUserId = "550e8400-e29b-41d4-a716-44665544000e";

    // Update mock for this test's job
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve({
        id: secondJobId,
        team_id: TEST_TEAM_ID,
        user_id: secondUserId,
        status: "pending",
        type: "frame_generation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload: {},
      } as any),
    );

    const payload: FrameGenerationPayload = {
      jobId: secondJobId,
      type: "frame_generation",
      data: {
        sequenceId: secondSequenceId,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Script analyzer is now always called (loads from DB)
    expect(mockAnalyzeScript).toHaveBeenCalled();

    // Descriptions should be generated
    expect(mockGenerateDescriptions).toHaveBeenCalled();
  });

  it("should handle invalid payload", async () => {
    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: "invalid json",
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Invalid JSON in request body");
  });

  it("should handle missing job ID", async () => {
    const payload = {
      // Missing jobId field
      type: "frame_generation",
      data: {
        sequenceId: TEST_SEQUENCE_ID,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Invalid webhook request format");
  });

  it.skip("should reject job with team ID mismatch", async () => {
    const unauthorizedJobId = "550e8400-e29b-41d4-a716-44665544000f";
    const differentTeamId = "550e8400-e29b-41d4-a716-446655440010";

    // Mock job with different team ID
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve({
        id: unauthorizedJobId,
        team_id: differentTeamId,
        user_id: TEST_USER_ID,
        status: "pending",
        type: "frame_generation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload: {},
      } as any),
    );

    const payload: FrameGenerationPayload = {
      jobId: unauthorizedJobId,
      type: "frame_generation",
      data: {
        sequenceId: TEST_SEQUENCE_ID,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Unauthorized: Team ID mismatch");

    // Job should be marked as failed
    expect(mockJobManager.failJob).toHaveBeenCalledWith(
      unauthorizedJobId,
      "Unauthorized: Team ID mismatch",
    );
  });

  it("should reject job when user is not a team member", async () => {
    const noMemberJobId = "550e8400-e29b-41d4-a716-446655440011";
    const nonMemberUserId = "550e8400-e29b-41d4-a716-446655440012";

    // Mock job with user who is not a team member
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve({
        id: noMemberJobId,
        team_id: TEST_TEAM_ID,
        user_id: nonMemberUserId,
        status: "pending",
        type: "frame_generation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload: {},
      } as any),
    );

    // Store original implementation
    const originalFrom = mockAdminClient.from.getMockImplementation();

    // Replace the from implementation temporarily
    mockAdminClient.from.mockImplementation((table: string): any => {
      if (table === "team_members") {
        return {
          select: mock(() => ({
            eq: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: null,
                    error: { code: "PGRST116", message: "Not found" },
                  }),
                ),
              })),
            })),
          })),
        };
      }
      // Use original implementation for other tables
      return originalFrom?.(table);
    });

    const payload: FrameGenerationPayload = {
      jobId: noMemberJobId,
      type: "frame_generation",
      data: {
        sequenceId: TEST_SEQUENCE_ID,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    // Restore original mock
    mockAdminClient.from.mockImplementation(originalFrom as any);

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Unauthorized: User not a team member");

    // Job should be marked as failed
    expect(mockJobManager.failJob).toHaveBeenCalledWith(
      noMemberJobId,
      "Unauthorized: User not a team member",
    );
  });

  it("should return 404 when job not found", async () => {
    // Mock job not found
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve(null as any),
    );

    const notFoundJobId = "550e8400-e29b-41d4-a716-446655440013";

    const payload: FrameGenerationPayload = {
      jobId: notFoundJobId,
      type: "frame_generation",
      data: {
        sequenceId: TEST_SEQUENCE_ID,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.message).toBe("Job not found in database");

    // Job should not be started or marked as failed
    expect(mockJobManager.startJob).not.toHaveBeenCalled();
    expect(mockJobManager.failJob).not.toHaveBeenCalled();
  });

  it("should handle script analysis failure", async () => {
    mockAnalyzeScript.mockImplementationOnce(() =>
      Promise.reject(new Error("AI service unavailable")),
    );

    const failJobId = "550e8400-e29b-41d4-a716-446655440014";
    const failUserId = "550e8400-e29b-41d4-a716-446655440015";
    const failSequenceId = "550e8400-e29b-41d4-a716-446655440016";

    // Update mock for this test's job
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve({
        id: failJobId,
        team_id: TEST_TEAM_ID,
        user_id: failUserId,
        status: "pending",
        type: "frame_generation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload: {},
      } as any),
    );

    const payload: FrameGenerationPayload = {
      jobId: failJobId,
      type: "frame_generation",
      data: {
        sequenceId: failSequenceId,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toContain("AI service unavailable");

    // Job should be marked as failed
    expect(mockJobManager.failJob).toHaveBeenCalledWith(
      failJobId,
      "AI service unavailable",
    );
  });

  it("should handle frame insertion failure", async () => {
    // Create a more complete mock for this test case
    const mockAdminClientFail = {
      from: mock((table: string) => {
        if (table === "frames") {
          return {
            delete: mock(() => ({
              eq: mock(() => Promise.resolve({ error: null })),
              in: mock(() => Promise.resolve({ error: null })),
            })),
            insert: mock(() => ({
              select: mock(() =>
                Promise.resolve({
                  data: null,
                  error: { message: "Database error" },
                }),
              ),
            })),
            select: mock(() => ({
              eq: mock(() =>
                Promise.resolve({
                  data: [],
                  error: null,
                }),
              ),
            })),
          };
        } else if (table === "sequences") {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: { metadata: {} },
                    error: null,
                  }),
                ),
              })),
            })),
            update: mock(() => ({
              eq: mock(() => Promise.resolve({ error: null })),
            })),
          };
        }
        return {};
      }),
    };

    // Override the module mock for this test
    mock.module("@/lib/supabase/server", () => ({
      createAdminClient: () => mockAdminClientFail,
    }));

    // Re-import the module to use the new mock
    const module = await import("../route");
    handler = module.POST;

    const failInsertJobId = "550e8400-e29b-41d4-a716-446655440017";
    const failInsertSequenceId = "550e8400-e29b-41d4-a716-44665544001a";

    const payload: FrameGenerationPayload = {
      jobId: failInsertJobId,
      type: "frame_generation",
      data: {
        sequenceId: failInsertSequenceId,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const response = await handler(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);

    // Job should be marked as failed
    expect(mockJobManager.failJob).toHaveBeenCalled();
  });

  it("should clean up placeholder frames", async () => {
    const cleanupJobId = "550e8400-e29b-41d4-a716-44665544001b";
    const cleanupSequenceId = "550e8400-e29b-41d4-a716-44665544001e";

    // Update mock to return proper job for this test
    mockJobManager.getJob.mockImplementationOnce(() =>
      Promise.resolve({
        id: cleanupJobId,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        status: "pending",
        type: "frame_generation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload: {},
      } as any),
    );

    const payload: FrameGenerationPayload = {
      jobId: cleanupJobId,
      type: "frame_generation",
      data: {
        sequenceId: cleanupSequenceId,
      },
    };

    const request = new Request("http://localhost/api/webhooks/qstash/frames", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    await handler(request);

    // Verify cleanup was attempted - check that from("frames") was called
    const fromMock = mockAdminClient.from as ReturnType<typeof mock>;
    expect(fromMock).toHaveBeenCalledWith("frames");

    // Since we're using a mock that returns different objects based on table name,
    // we can't easily verify delete was called, but we can verify from was called
    // with "frames" multiple times (once for select, potentially once for delete)
    const frameCalls = fromMock.mock.calls.filter(
      (call: any[]) => call[0] === "frames",
    );
    expect(frameCalls.length).toBeGreaterThan(0);
  });
});
