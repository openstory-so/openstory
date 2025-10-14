/**
 * Tests for frame generation actions
 */

// Set required environment variables BEFORE any imports
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET = "test-secret-key-for-testing-purposes-only";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { User } from "@/lib/auth/config";
import type { TeamRole } from "@/lib/auth/constants";
import type { GenerateFramesInput } from "../index";

// ===========================
// Mock Auth Utilities
// ===========================
const mockUser: User = {
  id: "123e4567-e89b-12d3-a456-426614174001",
  email: "test@example.com",
  name: "Test User",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  isAnonymous: false,
  onboardingCompleted: true,
};

const mockGetUser = mock((): Promise<User | null> => Promise.resolve(mockUser));
const mockGetUserRole = mock(
  (_userId: string, _teamId: string): Promise<TeamRole | null> =>
    Promise.resolve("member" as TeamRole),
);

// Mock dependencies - create function so we can reset for each test
const createMockServerClient = () =>
  mock(() => {
    let _callCount = 0;
    return {
      from: mock((table: string) => {
        _callCount++;
        if (table === "sequences") {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: {
                      id: "123e4567-e89b-12d3-a456-426614174000",
                      team_id: "123e4567-e89b-12d3-a456-426614174002",
                      name: "Test Sequence",
                      script: "This is a test script for frame generation.",
                      style_id: "style-123",
                      styles: {
                        metadata: { theme: "dark" },
                      },
                    },
                    error: null,
                  }),
                ),
              })),
            })),
            update: mock(() => ({
              eq: mock(() => ({
                select: mock(() =>
                  Promise.resolve({
                    data: {
                      id: "123e4567-e89b-12d3-a456-426614174000",
                      status: "processing",
                    },
                    error: null,
                  }),
                ),
              })),
            })),
          };
        } else if (table === "team_members") {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                eq: mock(() => ({
                  single: mock(() =>
                    Promise.resolve({
                      data: { id: "member-123" },
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
                  data: null,
                  error: null,
                }),
              ),
            })),
            insert: mock(() => ({
              select: mock(() =>
                Promise.resolve({
                  data: [
                    {
                      id: "frame-1",
                      description: "Test frame description",
                      sequence_id: "123e4567-e89b-12d3-a456-426614174000",
                    },
                  ],
                  error: null,
                }),
              ),
            })),
          };
        }
        return {
          select: mock(() => ({
            eq: mock(() => ({
              single: mock(() =>
                Promise.resolve({
                  data: null,
                  error: null,
                }),
              ),
            })),
          })),
        };
      }),
    };
  });

let mockCreateServerClient = createMockServerClient();

const mockCreateAdminClient = mock(() => ({
  from: mock(() => ({
    insert: mock(() =>
      Promise.resolve({
        data: null,
        error: null,
      }),
    ),
  })),
}));

const mockJobManager = {
  createJob: mock(() =>
    Promise.resolve({
      id: "job-123",
      type: "frame_generation",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  ),
};

const mockQStashClient = {
  publishFrameGenerationJob: mock(() =>
    Promise.resolve({
      messageId: "msg-123",
      deduplicated: false,
    }),
  ),
  publishImageJob: mock(() =>
    Promise.resolve({
      messageId: "img-msg-123",
      deduplicated: false,
    }),
  ),
};

describe("generateFramesAction", () => {
  beforeEach(() => {
    // Set up all module mocks inside beforeEach

    // Mock authentication utilities - must export all functions to prevent import errors
    mock.module("@/lib/auth/server", () => ({
      getUser: mockGetUser,
      getSession: mock(() =>
        Promise.resolve({
          user: mockUser,
          session: { token: "mock-token" },
        }),
      ),
      requireAuth: mock(() =>
        Promise.resolve({
          user: mockUser,
          session: { token: "mock-token" },
        }),
      ),
      getUserWithTeam: mock(() =>
        Promise.resolve({
          user: mockUser,
          teamId: "123e4567-e89b-12d3-a456-426614174002",
          teamRole: "member",
        }),
      ),
      checkTeamAccess: mock(() => Promise.resolve(true)),
      createAnonymousSession: mock(() =>
        Promise.resolve({
          user: mockUser,
          session: { token: "mock-token" },
        }),
      ),
      signOut: mock(() => Promise.resolve({ success: true })),
    }));

    mock.module("@/lib/auth/permissions", () => ({
      getUserRole: mockGetUserRole,
    }));

    mock.module("@/lib/supabase/server", () => ({
      createServerClient: mockCreateServerClient,
      createAdminClient: mockCreateAdminClient,
    }));

    mock.module("@/lib/qstash/job-manager", () => ({
      getJobManager: () => mockJobManager,
    }));

    mock.module("@/lib/qstash/client", () => ({
      getQStashClient: () => mockQStashClient,
    }));

    mock.module("@/lib/ai/script-analyzer", () => ({
      analyzeScriptForFrames: mock(() =>
        Promise.resolve({
          scenes: [
            {
              sceneNumber: 1,
              startTime: 0,
              endTime: 3,
              description: "Opening scene",
              text: "This is a test script",
              visualPrompt: "Test visual prompt",
              audioPrompt: "Test audio prompt",
              metadata: {
                characters: [],
                location: "Test location",
                mood: "neutral",
                cameraAngle: "wide",
              },
            },
          ],
          totalDuration: 3,
          metadata: {
            genre: "test",
            mood: "neutral",
            pacing: "normal",
          },
        }),
      ),
    }));

    mock.module("@/lib/ai/frame-generator", () => ({
      generateFrameDescriptions: mock(() =>
        Promise.resolve({
          frames: [
            {
              orderIndex: 0,
              description: "Test frame 1",
              visualPrompt: "Test visual prompt 1",
              audioPrompt: "Test audio prompt 1",
              durationMs: 3000,
              sceneNumber: 1,
            },
          ],
          totalDuration: 3,
        }),
      ),
    }));

    mock.module("@/lib/services/image-generation.service", () => ({
      generateImageForFrame: mock(() =>
        Promise.resolve({
          success: true,
          imageUrl: "https://example.com/generated-image.jpg",
          metadata: {
            model: "test-model",
            prompt: "Test prompt",
          },
        }),
      ),
    }));

    mock.module("next/cache", () => ({
      revalidatePath: mock(() => {}),
    }));

    // Reset mocks for each test
    mockGetUser.mockClear();
    mockGetUserRole.mockClear();
    mockCreateServerClient = createMockServerClient();
    mockCreateAdminClient.mockClear();
    mockJobManager.createJob.mockClear();

    // Reset QStash client mock to success state
    mockQStashClient.publishFrameGenerationJob = mock(() =>
      Promise.resolve({
        messageId: "msg-123",
        deduplicated: false,
      }),
    );
  });

  it("should successfully generate frames with basic input", async () => {
    const { generateFramesAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = await generateFramesAction(input);

    expect(result.success).toBe(true);
    expect(result.jobId).toMatch(/^frames-/); // jobId starts with "frames-"
    expect(result.message).toBeDefined();
    expect(result.error).toBeUndefined();

    // Verify job was created
    expect(mockJobManager.createJob).toHaveBeenCalledTimes(1);
    expect(mockJobManager.createJob).toHaveBeenCalledWith({
      type: "image",
      payload: expect.objectContaining({
        sequenceId: input.sequenceId,
      }),
      userId: "123e4567-e89b-12d3-a456-426614174001",
      teamId: "123e4567-e89b-12d3-a456-426614174002",
    });

    // Verify QStash job was published
    expect(mockQStashClient.publishImageJob).toHaveBeenCalled();
  });

  it("should generate frames with custom options", async () => {
    const { generateFramesAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
      options: {
        framesPerScene: 3,
        generateThumbnails: true,
        aiProvider: "openai",
      },
    };

    const result = await generateFramesAction(input);

    expect(result.success).toBe(true);
    expect(result.jobId).toMatch(/^frames-/);
  });

  it("should handle sequence not found error", async () => {
    // Create a new mock for this specific test
    const mockSequenceNotFound = mock(() => ({
      auth: {
        getUser: mock(() =>
          Promise.resolve({
            data: {
              user: {
                id: "123e4567-e89b-12d3-a456-426614174001",
                email: "test@example.com",
              },
            },
          }),
        ),
      },
      from: mock((table: string) => {
        if (table === "sequences") {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: null,
                    error: { message: "Not found" },
                  }),
                ),
              })),
            })),
            update: mock(() => ({
              eq: mock(() => ({
                select: mock(() =>
                  Promise.resolve({
                    data: null,
                    error: null,
                  }),
                ),
              })),
            })),
          };
        }
        return {
          select: mock(() => ({
            eq: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: null,
                    error: null,
                  }),
                ),
              })),
            })),
          })),
        };
      }),
    }));

    // Override the module mock for this test
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: mockSequenceNotFound,
      createAdminClient: mockCreateAdminClient,
    }));

    // Re-import the module to use the new mock
    const { generateFramesAction: testAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "223e4567-e89b-12d3-a456-426614174999",
    };

    const result = await testAction(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sequence not found");
    expect(result.jobId).toBeUndefined();
  });

  it("should handle permission denied error", async () => {
    // Mock getUserRole to return null (user not a team member)
    mockGetUserRole.mockImplementationOnce(() => Promise.resolve(null));

    // Create a new mock for permission denied test
    const mockPermissionDenied = mock(() => ({
      auth: {
        getUser: mock(() =>
          Promise.resolve({
            data: {
              user: {
                id: "123e4567-e89b-12d3-a456-426614174001",
                email: "test@example.com",
              },
            },
          }),
        ),
      },
      from: mock((table: string) => {
        if (table === "sequences") {
          // Sequence exists
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(() =>
                  Promise.resolve({
                    data: {
                      id: "123e4567-e89b-12d3-a456-426614174000",
                      team_id: "123e4567-e89b-12d3-a456-426614174002",
                      name: "Test Sequence",
                      script: "Test script",
                      style_id: "style-123",
                    },
                    error: null,
                  }),
                ),
              })),
            })),
            update: mock(() => ({
              eq: mock(() => ({
                select: mock(() =>
                  Promise.resolve({
                    data: {
                      id: "123e4567-e89b-12d3-a456-426614174000",
                      status: "processing",
                    },
                    error: null,
                  }),
                ),
              })),
            })),
          };
        } else if (table === "team_members") {
          // User not a team member
          return {
            select: mock(() => ({
              eq: mock(() => ({
                eq: mock(() => ({
                  single: mock(() =>
                    Promise.resolve({
                      data: null,
                      error: null,
                    }),
                  ),
                })),
              })),
            })),
          };
        }
        return {
          select: mock(() => ({
            eq: mock(() => ({
              single: mock(() =>
                Promise.resolve({
                  data: null,
                  error: null,
                }),
              ),
            })),
          })),
        };
      }),
    }));

    // Override the module mock for this test
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: mockPermissionDenied,
      createAdminClient: mockCreateAdminClient,
    }));

    // Re-import the module to use the new mock
    const { generateFramesAction: testAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = await testAction(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Access denied: not a member of this team");
  });

  it("should handle custom options", async () => {
    const { generateFramesAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
      options: {
        framesPerScene: 7,
        generateDescriptions: true,
        aiProvider: "anthropic",
      },
    };

    const result = await generateFramesAction(input);

    expect(result.success).toBe(true);

    // Verify job was created (one per frame with description)
    expect(mockJobManager.createJob).toHaveBeenCalled();
  });

  it("should handle QStash publishing error", async () => {
    const { generateFramesAction } = await import("../index");

    // Mock QStash error for image job
    mockQStashClient.publishImageJob = mock(() =>
      Promise.reject(new Error("QStash service unavailable")),
    );

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = await generateFramesAction(input);

    // The action should still succeed but with a partial failure message
    // since frames are created but image generation fails
    expect(result.success).toBe(true);
    expect(result.message).toContain("created successfully");
  });

  it("should handle options for frame generation", async () => {
    const { generateFramesAction } = await import("../index");

    const input: GenerateFramesInput = {
      sequenceId: "123e4567-e89b-12d3-a456-426614174000",
      options: {
        framesPerScene: 2,
      },
    };

    const result = await generateFramesAction(input);

    // Debug: log the result to see why it's failing
    if (!result.success) {
      console.error("Test failed with error:", result.error);
    }

    expect(result.success).toBe(true);

    // The implementation creates frames and queues image jobs
    expect(mockQStashClient.publishImageJob).toHaveBeenCalled();
    expect(result.jobId).toMatch(/^frames-/);
  });

  afterEach(() => {
    // Restore all mocks after each test to prevent interference
    mock.restore();
  });
});
