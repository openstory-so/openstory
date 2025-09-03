// @ts-nocheck - Disabled test with Bun migration issues
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

// Create mock functions at module level
const mockFrom = mock(() => {});
const mockCreateUser = mock(() =>
  Promise.resolve({ data: { user: { id: "test" } }, error: null }),
);
const mockListBuckets = mock(() => Promise.resolve({ data: [], error: null }));
const mockCreateBucket = mock(() =>
  Promise.resolve({ data: { id: "test" }, error: null }),
);

// Mock the createAdminClient function
mock.module("@/lib/supabase/server", () => ({
  createAdminClient: mock(() => ({
    from: mockFrom,
    auth: {
      admin: {
        createUser: mockCreateUser,
      },
    },
    storage: {
      listBuckets: mockListBuckets,
      createBucket: mockCreateBucket,
    },
  })),
}));

// Mock NextResponse.json to return a testable object
mock.module("next/server", () => ({
  NextRequest,
  NextResponse: {
    json: mock((body, init) => ({
      json: async () => body,
      status: init?.status || 200,
      headers: new Headers(init?.headers),
    })),
  },
}));

describe.skip("POST /api/v1/setup/database", () => {
  beforeEach(() => {
    // Clear all mock calls and reset implementations
    mockFrom.mockClear();
    mockCreateUser.mockClear();
    mockListBuckets.mockClear();
    mockCreateBucket.mockClear();

    // Setup default mock behavior
    mockFrom.mockReturnValue({
      select: mock().mockReturnThis(),
      limit: mock().mockReturnThis(),
      insert: mock().mockReturnThis(),
      error: null,
      data: null,
    } as any);

    mockListBuckets.mockResolvedValue({
      data: [],
      error: null,
    });

    mockCreateBucket.mockResolvedValue({
      data: { id: "test-bucket" },
      error: null,
    });

    mockCreateUser.mockResolvedValue({
      data: { user: { id: "test-user-id" } },
      error: null,
    });

    // Mock console methods
    const _originalConsoleLog = console.log;
    const _originalConsoleError = console.error;
    const _originalConsoleWarn = console.warn;
    spyOn(console, "log").mockImplementation((..._args) => {});
    spyOn(console, "error").mockImplementation((..._args) => {});
    spyOn(console, "warn").mockImplementation((..._args) => {});
  });

  afterEach(() => {
    // Clear mocks after each test
    mockFrom.mockClear();
    mockCreateUser.mockClear();
    mockListBuckets.mockClear();
    mockCreateBucket.mockClear();
  });

  describe("Database operations", () => {
    it("should check and create missing tables", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      // Should check all required tables
      expect(mockFrom).toHaveBeenCalledWith("teams");
      expect(mockFrom).toHaveBeenCalledWith("users");
      expect(mockFrom).toHaveBeenCalledWith("team_members");
      expect(mockFrom).toHaveBeenCalledWith("sequences");
      expect(mockFrom).toHaveBeenCalledWith("frames");
      expect(mockFrom).toHaveBeenCalledWith("styles");
      expect(mockFrom).toHaveBeenCalledWith("characters");
      expect(mockFrom).toHaveBeenCalledWith("vfx");
      expect(mockFrom).toHaveBeenCalledWith("audio");
    });

    it("should handle database query errors", async () => {
      mockFrom.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        error: { message: "Database error" },
        data: null,
      } as any);

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Database check failed");
    });
  });

  describe("Storage bucket operations", () => {
    it("should check existing buckets", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      expect(mockListBuckets).toHaveBeenCalled();
    });

    it("should create missing buckets", async () => {
      mockListBuckets.mockResolvedValue({
        data: [],
        error: null,
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      // Should create all required buckets
      expect(mockCreateBucket).toHaveBeenCalledWith("sequences", {
        public: true,
        allowedMimeTypes: ["image/*", "video/*"],
      });
      expect(mockCreateBucket).toHaveBeenCalledWith("characters", {
        public: true,
        allowedMimeTypes: ["image/*"],
      });
      expect(mockCreateBucket).toHaveBeenCalledWith("styles", {
        public: true,
        allowedMimeTypes: ["image/*"],
      });
      expect(mockCreateBucket).toHaveBeenCalledWith("vfx", {
        public: true,
        allowedMimeTypes: ["video/*", "image/*"],
      });
      expect(mockCreateBucket).toHaveBeenCalledWith("audio", {
        public: true,
        allowedMimeTypes: ["audio/*"],
      });
    });

    it("should skip creating existing buckets", async () => {
      mockListBuckets.mockResolvedValue({
        data: [
          { id: "sequences", name: "sequences" },
          { id: "characters", name: "characters" },
        ],
        error: null,
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      // Should only create missing buckets
      expect(mockCreateBucket).not.toHaveBeenCalledWith(
        "sequences",
        expect.any(Object),
      );
      expect(mockCreateBucket).not.toHaveBeenCalledWith(
        "characters",
        expect.any(Object),
      );
      expect(mockCreateBucket).toHaveBeenCalledWith(
        "styles",
        expect.any(Object),
      );
      expect(mockCreateBucket).toHaveBeenCalledWith("vfx", expect.any(Object));
      expect(mockCreateBucket).toHaveBeenCalledWith(
        "audio",
        expect.any(Object),
      );
    });

    it("should handle bucket creation errors gracefully", async () => {
      mockCreateBucket.mockResolvedValue({
        data: null,
        error: { message: "Bucket creation failed" },
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Should not fail the entire operation
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe("seedData option", () => {
    it("should create test user when seedData is true", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ seedData: true }),
        },
      );

      await POST(request);

      expect(mockCreateUser).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "test123456",
        email_confirm: true,
      });

      expect(mockFrom).toHaveBeenCalledWith("users");
    });

    it("should not create test user when seedData is false", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ seedData: false }),
        },
      );

      await POST(request);

      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it("should handle auth user creation failure gracefully", async () => {
      mockCreateUser.mockResolvedValue({
        data: null,
        error: { message: "User already exists" },
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ seedData: true }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain("Failed to create test user");
    });

    it("should handle user profile creation failure gracefully", async () => {
      mockFrom.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        insert: mock().mockReturnValue({
          error: { message: "Insert failed" },
          data: null,
        }),
        error: null,
        data: null,
      } as any);

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ seedData: true }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain("Failed to create user profile");
    });
  });

  describe("Response format", () => {
    it("should return success response with statistics", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.tables).toBeDefined();
      expect(data.storage).toBeDefined();
      expect(data.testData).toBe(false);
    });

    it("should include seedData status in response", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ seedData: true }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.testData).toBe(true);
    });

    it("should handle invalid request body", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: "invalid json",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid request body");
    });
  });

  describe("Error handling", () => {
    it("should handle unexpected errors", async () => {
      mockFrom.mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Database check failed");
    });

    it("should handle storage bucket list errors", async () => {
      mockListBuckets.mockResolvedValue({
        data: null,
        error: { message: "Storage error" },
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Storage bucket check failed");
    });
  });
});
