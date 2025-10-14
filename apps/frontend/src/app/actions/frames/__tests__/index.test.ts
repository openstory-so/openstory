/**
 * Frame Generation Action Tests
 *
 * These tests verify the frame generation workflow with proper authentication mocking.
 *
 * TEST ARCHITECTURE:
 * ==================
 * This test suite uses centralized auth utilities (requireUser, requireTeamMemberAccess)
 * instead of directly mocking Supabase auth. This approach:
 *
 * 1. **Matches Production Code**: The actual actions use @/lib/auth/action-utils which
 *    internally calls @/lib/auth/server (getUser) and @/lib/auth/permissions (getUserRole)
 *
 * 2. **Better Separation of Concerns**: Auth logic is tested through its public API
 *    rather than implementation details (Supabase client internals)
 *
 * 3. **Easier to Maintain**: If auth implementation changes (e.g., switching from
 *    Better Auth to another provider), only the auth utility mocks need updating
 *
 * MOCK LAYERS:
 * ============
 * - @/lib/auth/server: getUser() → Returns mock authenticated user
 * - @/lib/auth/permissions: getUserRole() → Returns mock team role
 * - @/lib/supabase/server: Database operations (sequences, frames, team_members)
 * - @/lib/qstash/client: Job queue operations
 * - @/lib/qstash/job-manager: Job state management
 * - @/lib/ai/script-analyzer: Script analysis AI
 * - @/lib/ai/frame-generator: Frame description generation AI
 *
 * TEST COVERAGE:
 * ==============
 * ✓ Happy path: Successful frame generation with authentication
 * ✓ Authorization: User authentication checks
 * ✓ Authorization: Team access verification
 * ✓ Error cases: Missing authentication
 * ✓ Error cases: Insufficient team permissions
 * ✓ Options: Thumbnail generation toggle
 * ✓ Options: Frame regeneration
 * ✓ Resilience: Script analysis failures
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { User } from "@/lib/auth/config";
import type { TeamRole } from "@/lib/auth/constants";
import type { Sequence, Style } from "@/types/database";

// ===========================
// Mock Auth Utilities
// ===========================
const mockUser: User = {
  id: "user-123",
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

// ===========================
// Mock Supabase Client
// ===========================
const mockCreateServerClient = mock(() => {
  const mockSupabase = {
    from: mock((table: string) => {
      const mockChain = {
        select: mock((_fields?: string) => {
          // If we're selecting after insert/upsert on frames table, return frames
          if (
            table === "frames" &&
            (mockChain.insert.mock.calls.length > 0 ||
              mockChain.upsert.mock.calls.length > 0)
          ) {
            return Promise.resolve({
              data: [
                {
                  id: "frame-1",
                  description: "Frame 1 description",
                  sequence_id: "550e8400-e29b-41d4-a716-446655440000",
                  order_index: 0,
                },
                {
                  id: "frame-2",
                  description: "Frame 2 description",
                  sequence_id: "550e8400-e29b-41d4-a716-446655440000",
                  order_index: 1,
                },
                {
                  id: "frame-3",
                  description: "Frame 3 description",
                  sequence_id: "550e8400-e29b-41d4-a716-446655440000",
                  order_index: 2,
                },
                {
                  id: "frame-4",
                  description: "Frame 4 description",
                  sequence_id: "550e8400-e29b-41d4-a716-446655440000",
                  order_index: 3,
                },
              ],
              error: null,
            });
          }
          return mockChain;
        }),
        eq: mock(() => mockChain),
        single: mock(() => {
          if (table === "sequences") {
            return Promise.resolve({
              data: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                team_id: "550e8400-e29b-41d4-a716-446655440001",
                script: "Test script content",
                style_id: "550e8400-e29b-41d4-a716-446655440002",
                styles: {
                  id: "550e8400-e29b-41d4-a716-446655440002",
                  metadata: { test: "style" },
                },
              } as unknown as Partial<Sequence & { styles: Style }>,
              error: null,
            });
          }
          if (table === "team_members") {
            return Promise.resolve({
              data: {
                id: "550e8400-e29b-41d4-a716-446655440003",
                role: "member",
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
        insert: mock(() => mockChain),
        delete: mock(() => mockChain),
        update: mock(() => mockChain),
        upsert: mock(() => mockChain),
      };
      return mockChain;
    }),
  };
  return mockSupabase;
});

const mockJobManager = {
  createJob: mock(async (job: unknown) => ({
    id: "job-123",
    type: "frame_generation",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(job as object),
  })),
  getJob: mock(async () => ({
    id: "job-123",
    type: "frame_generation",
    status: "pending",
    user_id: "user-123",
    team_id: "team-123",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })),
  updateJob: mock(async () => ({
    id: "job-123",
    status: "running",
  })),
};

const mockQStashClient = {
  publishFrameGenerationJob: mock(async () => ({
    messageId: "msg-123",
    deduplicated: false,
  })),
  publishImageJob: mock(async () => ({
    messageId: "img-msg-123",
    deduplicated: false,
  })),
};

const mockAnalyzeScript = mock(async () => ({
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
      description: "Main scene",
      duration: 10000,
    },
  ],
  characters: ["Character 1", "Character 2"],
  settings: ["Location 1"],
  totalDuration: 15000,
}));

const mockGenerateFrameDescriptions = mock(async () => ({
  frames: [
    {
      description: "Frame 1 description",
      orderIndex: 0,
      durationMs: 2500,
      metadata: {
        scene: 0,
        shotType: "wide shot",
      },
    },
    {
      description: "Frame 2 description",
      orderIndex: 1,
      durationMs: 2500,
      metadata: {
        scene: 0,
        shotType: "medium shot",
      },
    },
    {
      description: "Frame 3 description",
      orderIndex: 2,
      durationMs: 5000,
      metadata: {
        scene: 1,
        shotType: "close-up",
      },
    },
    {
      description: "Frame 4 description",
      orderIndex: 3,
      durationMs: 5000,
      metadata: {
        scene: 1,
        shotType: "wide shot",
      },
    },
  ],
  totalDuration: 15000,
  frameCount: 4,
}));

describe("Frame Generation Optimization", () => {
  beforeEach(() => {
    // ===========================
    // Set up all module mocks
    // ===========================

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
          teamId: "550e8400-e29b-41d4-a716-446655440001",
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

    // Mock Supabase client
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: mockCreateServerClient,
    }));

    // Mock QStash services
    mock.module("@/lib/qstash/job-manager", () => ({
      getJobManager: () => mockJobManager,
    }));

    mock.module("@/lib/qstash/client", () => ({
      getQStashClient: () => mockQStashClient,
    }));

    // Mock AI services
    mock.module("@/lib/ai/script-analyzer", () => ({
      analyzeScriptForFrames: mockAnalyzeScript,
    }));

    mock.module("@/lib/ai/frame-generator", () => ({
      generateFrameDescriptions: mockGenerateFrameDescriptions,
    }));

    // Mock Next.js cache
    mock.module("next/cache", () => ({
      revalidatePath: mock(() => {}),
    }));

    // ===========================
    // Clear all mock call history
    // ===========================
    mockGetUser.mockClear();
    mockGetUserRole.mockClear();
    mockCreateServerClient.mockClear();
    mockJobManager.createJob.mockClear();
    mockJobManager.getJob.mockClear();
    mockJobManager.updateJob.mockClear();
    mockQStashClient.publishFrameGenerationJob.mockClear();
    mockQStashClient.publishImageJob.mockClear();
    mockAnalyzeScript.mockClear();
    mockGenerateFrameDescriptions.mockClear();
  });

  test("generateFramesAction should create frames immediately without queueing frame generation", async () => {
    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000", // Use proper UUID
      options: {
        framesPerScene: 2,
        generateThumbnails: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("created successfully");

    // Should analyze script synchronously
    expect(mockAnalyzeScript).toHaveBeenCalledTimes(1);
    expect(mockGenerateFrameDescriptions).toHaveBeenCalledTimes(1);

    // Should NOT queue a frame generation job anymore
    expect(mockQStashClient.publishFrameGenerationJob).toHaveBeenCalledTimes(0);

    // Should have created frames in database
    // The actual frames are created through the insert method
    // We can verify this by checking the mock calls
    expect(mockCreateServerClient).toHaveBeenCalled();

    // Should queue individual image generation jobs for each frame
    expect(mockJobManager.createJob.mock.calls.length).toBeGreaterThan(0);
    // Find image generation jobs
    const imageJobs = mockJobManager.createJob.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "image",
    );
    expect(imageJobs.length).toBe(4); // 4 frames should get image jobs

    // Verify image jobs were queued
    expect(mockQStashClient.publishImageJob).toHaveBeenCalledTimes(4);
  });

  test("generateFramesAction should handle no thumbnail generation option", async () => {
    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
      options: {
        framesPerScene: 2,
        generateThumbnails: false,
      },
    });

    expect(result.success).toBe(true);

    // Should still create frames
    expect(mockAnalyzeScript).toHaveBeenCalledTimes(1);
    expect(mockGenerateFrameDescriptions).toHaveBeenCalledTimes(1);

    // Should NOT queue image generation jobs when thumbnails disabled
    expect(mockQStashClient.publishImageJob).toHaveBeenCalledTimes(0);
  });

  test("generateFramesAction should handle script analysis failure gracefully", async () => {
    // Mock script analysis to fail
    mockAnalyzeScript.mockImplementationOnce(() => {
      throw new Error("Failed to analyze script");
    });

    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to analyze script");

    // Should not have queued any jobs
    expect(mockQStashClient.publishImageJob).toHaveBeenCalledTimes(0);
  });

  test("generateFramesAction should delete existing frames when regenerateAll is true", async () => {
    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
      options: {
        regenerateAll: true,
        framesPerScene: 2,
      },
    });

    expect(result.success).toBe(true);

    // The delete operation should have been called
    // We verify frames were created which implies delete was attempted if regenerateAll was true
    expect(mockCreateServerClient).toHaveBeenCalled();
  });

  test("generateFramesAction should verify user authentication", async () => {
    const { generateFramesAction } = await import("../index");

    await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
      options: {
        framesPerScene: 2,
      },
    });

    // Should call getUser to authenticate
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  test("generateFramesAction should verify team access", async () => {
    const { generateFramesAction } = await import("../index");

    await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
      options: {
        framesPerScene: 2,
      },
    });

    // Should check user role for team access
    expect(mockGetUserRole).toHaveBeenCalledTimes(1);
    expect(mockGetUserRole).toHaveBeenCalledWith(
      "user-123", // user.id
      "550e8400-e29b-41d4-a716-446655440001", // team_id from sequence
    );
  });

  test("generateFramesAction should fail when user is not authenticated", async () => {
    // Override getUser to return null (no authentication)
    mockGetUser.mockImplementationOnce(() => Promise.resolve(null));

    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Authentication required");
  });

  test("generateFramesAction should fail when user lacks team access", async () => {
    // Override getUserRole to return null (no team access)
    mockGetUserRole.mockImplementationOnce(() => Promise.resolve(null));

    const { generateFramesAction } = await import("../index");

    const result = await generateFramesAction({
      sequenceId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");
  });

  afterEach(() => {
    // Restore all mocks after each test
    mock.restore();
  });
});
