/**
 * Test utilities for QStash async job queue integration
 * Provides mocks, fixtures, and test helpers for unit testing
 */

import { expect, mock } from "bun:test";
import type { VelroError } from "@/lib/errors";
import type { Job } from "@/types/database";
import type { JobPayload, QStashResponse } from "./client";
import type { MotionGenerationPayload } from "./types";

/**
 * Mock QStash client for testing
 */
export const createMockQStashClient = () => ({
  publishMessage: mock().mockResolvedValue({
    messageId: "msg_test123456789",
    deduplicated: false,
  } as QStashResponse),
  publishImageJob: mock().mockResolvedValue({
    messageId: "msg_image123456789",
    deduplicated: false,
  } as QStashResponse),
  publishVideoJob: mock().mockResolvedValue({
    messageId: "msg_video123456789",
    deduplicated: false,
  } as QStashResponse),
  publishScriptJob: mock().mockResolvedValue({
    messageId: "msg_script123456789",
    deduplicated: false,
  } as QStashResponse),
  cancelMessage: mock().mockResolvedValue(undefined),
  getMessage: mock().mockResolvedValue({
    messageId: "msg_test123456789",
    url: "https://example.com/webhook",
    body: "test body",
  }),
});

/**
 * Mock Supabase client for testing
 */
export const createMockSupabaseClient = () => {
  // Create a proper mock chain that can be awaited
  const createQueryChain = () => {
    const chain = {
      select: mock().mockReturnThis(),
      insert: mock().mockReturnThis(),
      update: mock().mockReturnThis(),
      delete: mock().mockReturnThis(),
      eq: mock().mockReturnThis(),
      single: mock().mockReturnThis(),
      limit: mock().mockReturnThis(),
      order: mock().mockReturnThis(),
      range: mock().mockReturnThis(),
      // biome-ignore lint/suspicious/noThenProperty: Required for thenable mock
      then: mock().mockReturnThis(),
    };

    // Make the chain thenable - biome wants this as a property
    // biome-ignore lint/suspicious/noThenProperty: Required for thenable mock
    chain.then = mock((onResolve) => {
      const defaultResult = { data: [], error: null };
      return Promise.resolve(defaultResult).then(onResolve);
    });

    return chain;
  };

  const chainMock = createQueryChain();

  return {
    from: mock(() => chainMock),
    mockHelpers: {
      mockSelect: chainMock.select,
      mockInsert: chainMock.insert,
      mockUpdate: chainMock.update,
      mockDelete: chainMock.delete,
      mockEq: chainMock.eq,
      mockSingle: chainMock.single,
      mockLimit: chainMock.limit,
      mockOrder: chainMock.order,
      mockRange: chainMock.range,
    },
  };
};

/**
 * Mock QStash Receiver for signature verification testing
 */
export const createMockQStashReceiver = (shouldVerify = true) => ({
  verify: mock().mockResolvedValue(shouldVerify),
});

/**
 * Mock Job Manager for testing
 */
export const createMockJobManager = () => ({
  createJob: mock(),
  getJob: mock(),
  updateJob: mock(),
  cancelJob: mock(),
  startJob: mock(),
  completeJob: mock(),
  failJob: mock(),
  getJobsByStatus: mock(),
});

/**
 * Test job payload fixtures
 */
export const createTestJobPayload = (
  overrides?: Partial<JobPayload>,
): JobPayload => {
  const base = {
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    type: "image" as const,
    data: {
      prompt: "A beautiful landscape with mountains",
      style: "photographic",
      width: 1024,
      height: 1024,
    },
    userId: "550e8400-e29b-41d4-a716-446655440011",
    teamId: "550e8400-e29b-41d4-a716-446655440021",
  };

  // Handle different payload types
  if (overrides?.type === "motion") {
    const motionOverrides = overrides as Partial<MotionGenerationPayload>;
    return {
      jobId: motionOverrides.jobId || base.jobId,
      type: "motion" as const,
      data: {
        frameId: "550e8400-e29b-41d4-a716-446655440030",
        sequenceId: "550e8400-e29b-41d4-a716-446655440031",
        thumbnailUrl: "https://example.com/thumbnail.jpg",
        model: "svd-lcm",
        ...(motionOverrides.data || {}),
      },
      userId: motionOverrides.userId || base.userId,
      teamId: motionOverrides.teamId || base.teamId,
    } as JobPayload;
  }

  // Type assertion to handle discriminated union
  return { ...base, ...overrides } as JobPayload;
};

/**
 * Test job record fixtures
 */
export const createTestJobRow = (overrides?: Partial<Job>): Job => ({
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "image",
  status: "pending",
  payload: {
    prompt: "A beautiful landscape with mountains",
    style: "photographic",
    width: 1024,
    height: 1024,
  },
  result: null,
  error: null,
  user_id: "550e8400-e29b-41d4-a716-446655440011",
  team_id: "550e8400-e29b-41d4-a716-446655440021",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  ...overrides,
});

/**
 * Test QStash webhook request fixtures
 */
export const createTestWebhookRequest = (
  overrides?: Partial<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
    url: string;
    method: string;
  }>,
) => {
  const baseHeaders = {
    "content-type": "application/json",
    "upstash-message-id": "msg_test123456789",
    "upstash-timestamp": "1704067200",
  };

  // Only add signature if not explicitly overridden
  const defaultHeaders = {
    ...baseHeaders,
    "upstash-signature": "test-signature-12345",
  };

  const headers = overrides?.headers || defaultHeaders;

  const defaultBody = createTestJobPayload();

  return {
    headers: new Headers(headers),
    json: mock().mockResolvedValue(overrides?.body || defaultBody),
    text: mock().mockResolvedValue(
      JSON.stringify(overrides?.body || defaultBody),
    ),
    url: overrides?.url || "https://example.com/api/v1/webhooks/qstash/image",
    method: overrides?.method || "POST",
  };
};

/**
 * Generate test QStash signature (mock implementation)
 */
export const generateTestSignature = (
  body: string,
  timestamp = "1704067200",
  key = "test-signing-key",
): string => {
  // This is a mock implementation for testing
  // In real usage, QStash generates the actual signature
  return `test-signature-${Buffer.from(`${key}-${timestamp}-${body.length}`)
    .toString("base64")
    .slice(0, 16)}`;
};

/**
 * Test environment variables setup
 */
export const setupTestEnv = () => {
  process.env.QSTASH_TOKEN = "test-qstash-token-12345";
  process.env.QSTASH_CURRENT_SIGNING_KEY = "test-current-signing-key";
  process.env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
  process.env.QSTASH_URL = "https://qstash.upstash.io";
  process.env.VERCEL_URL = "test-api.example.com";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
};

/**
 * Clean up test environment
 */
export const cleanupTestEnv = () => {
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.QSTASH_URL;
  delete process.env.VERCEL_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
};

/**
 * Assert helpers for testing
 */
export const assertJobMatches = (actualJob: Job, expectedJob: Partial<Job>) => {
  Object.entries(expectedJob).forEach(([key, value]) => {
    expect(actualJob[key as keyof Job]).toEqual(value);
  });
};

/**
 * Time-related test utilities
 */
export const createTestDate = (offset = 0): string => {
  const date = new Date("2024-01-01T00:00:00.000Z");
  date.setMinutes(date.getMinutes() + offset);
  return date.toISOString();
};

/**
 * UUID test utilities
 */
export const testUUIDs = {
  job1: "550e8400-e29b-41d4-a716-446655440001",
  job2: "550e8400-e29b-41d4-a716-446655440002",
  user1: "550e8400-e29b-41d4-a716-446655440011",
  user2: "550e8400-e29b-41d4-a716-446655440012",
  team1: "550e8400-e29b-41d4-a716-446655440021",
  team2: "550e8400-e29b-41d4-a716-446655440022",
  event1: "550e8400-e29b-41d4-a716-446655440031",
  sequence1: "550e8400-e29b-41d4-a716-446655440041",
  frame1: "550e8400-e29b-41d4-a716-446655440051",
  style1: "550e8400-e29b-41d4-a716-446655440061",
};

/**
 * Error test helpers
 */
export const expectVelroError = (
  error: unknown,
  code: string,
  statusCode: number,
) => {
  expect(error).toBeInstanceOf(Error);
  const velroError = error as VelroError;
  expect(velroError.code).toBe(code);
  expect(velroError.statusCode).toBe(statusCode);
};

/**
 * Mock Next.js Request/Response for API route testing
 */
export const createMockNextRequest = (options?: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  searchParams?: Record<string, string>;
}) => {
  const url = new URL(options?.url || "https://example.com/api/test");

  if (options?.searchParams) {
    Object.entries(options.searchParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  return {
    method: options?.method || "POST",
    url: url.toString(),
    headers: new Headers(options?.headers || {}),
    json: mock().mockResolvedValue(options?.body || {}),
    text: mock().mockResolvedValue(JSON.stringify(options?.body || {})),
  };
};

export const createMockNextResponse = () => ({
  json: mock().mockImplementation((data) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  })),
});

/**
 * Bun test setup helper
 */
export const setupBunMocks = () => {
  // Setup test environment
  setupTestEnv();

  return {
    restoreConsole: () => {
      // No-op for now
    },
    cleanupEnv: cleanupTestEnv,
  };
};
