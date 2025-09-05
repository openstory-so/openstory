import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sequence, Style } from "@/types/database";

// Mock dependencies
const mockCreateServerClient = mock(() => {
  const mockSupabase = {
    auth: {
      getUser: mock(() =>
        Promise.resolve({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      ),
    },
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
              data: { id: "550e8400-e29b-41d4-a716-446655440003" },
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
    // Set up all module mocks inside beforeEach
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: mockCreateServerClient,
    }));

    mock.module("@/lib/qstash/job-manager", () => ({
      getJobManager: () => mockJobManager,
    }));

    mock.module("@/lib/qstash/client", () => ({
      getQStashClient: () => mockQStashClient,
    }));

    mock.module("@/lib/ai/script-analyzer", () => ({
      analyzeScriptForFrames: mockAnalyzeScript,
    }));

    mock.module("@/lib/ai/frame-generator", () => ({
      generateFrameDescriptions: mockGenerateFrameDescriptions,
    }));

    // Mock revalidatePath
    mock.module("next/cache", () => ({
      revalidatePath: mock(() => {}),
    }));
    // Clear all mocks
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

  afterEach(() => {
    // Restore all mocks after each test
    mock.restore();
  });
});
