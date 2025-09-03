import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

// Mock the Supabase admin client
const mockSupabase = {
  from: mock(() => {}),
  auth: {
    admin: {
      createUser: mock(() => {}),
    },
  },
  storage: {
    listBuckets: mock(() => {}),
    createBucket: mock(() => {}),
  },
};

// Mock the createAdminClient function
mock.module("@/lib/supabase/server", () => ({
  createAdminClient: mock(() => mockSupabase),
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

describe("POST /api/v1/setup/database", () => {
  beforeEach(() => {
    mock.restore();

    // Setup default mock behavior
    mockSupabase.from.mockReturnValue({
      select: mock().mockReturnThis(),
      limit: mock().mockReturnThis(),
      insert: mock().mockReturnThis(),
      error: null,
      data: null,
    });

    mockSupabase.storage.listBuckets.mockResolvedValue({
      data: [],
      error: null,
    });

    mockSupabase.storage.createBucket.mockResolvedValue({
      data: { id: "test-bucket" },
      error: null,
    });

    mockSupabase.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: "test-user-id" } },
      error: null,
    });
  });

  describe("successful initialization", () => {
    it("should initialize database with default settings", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe("Database initialized successfully");
      expect(data.results).toBeDefined();
      expect(data.results.errors).toEqual([]);
    });

    it("should check all expected tables", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      const expectedTables = [
        "teams",
        "users",
        "team_members",
        "sequences",
        "frames",
        "styles",
        "characters",
        "audio",
        "vfx",
      ];

      expectedTables.forEach((table) => {
        expect(mockSupabase.from).toHaveBeenCalledWith(table);
      });
    });

    it("should create all expected storage buckets", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      expect(mockSupabase.storage.listBuckets).toHaveBeenCalled();

      const expectedBuckets = [
        "thumbnails",
        "videos",
        "characters",
        "styles",
        "audio",
        "scripts",
        "exports",
      ];

      expectedBuckets.forEach((bucket) => {
        expect(mockSupabase.storage.createBucket).toHaveBeenCalledWith(
          bucket,
          expect.any(Object),
        );
      });
    });

    it("should set correct public access for specific buckets", async () => {
      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );

      await POST(request);

      const publicBuckets = [
        "thumbnails",
        "videos",
        "characters",
        "styles",
        "audio",
      ];

      publicBuckets.forEach((bucket) => {
        expect(mockSupabase.storage.createBucket).toHaveBeenCalledWith(bucket, {
          public: true,
        });
      });

      // Scripts and exports should be private
      expect(mockSupabase.storage.createBucket).toHaveBeenCalledWith(
        "scripts",
        { public: false },
      );
      expect(mockSupabase.storage.createBucket).toHaveBeenCalledWith(
        "exports",
        { public: false },
      );
    });
  });

  describe("skipIfExists option", () => {
    it("should skip initialization if database already exists", async () => {
      // Mock existing teams table
      mockSupabase.from.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        error: null,
        data: [{ id: "existing-team" }],
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ skipIfExists: true }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe("Database already initialized");
      expect(data.skipped).toBe(true);
    });

    it("should proceed with initialization if skipIfExists is false", async () => {
      // Mock existing teams table
      mockSupabase.from.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        error: null,
        data: [{ id: "existing-team" }],
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ skipIfExists: false }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe("Database initialized successfully");
      expect(data.skipped).toBeUndefined();
    });

    it("should initialize if tables exist but are empty", async () => {
      // Mock empty teams table
      mockSupabase.from.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        error: null,
        data: [],
      });

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ skipIfExists: true }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.message).toBe("Database initialized successfully");
      expect(data.skipped).toBeUndefined();
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

      expect(mockSupabase.auth.admin.createUser).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "test123456",
        email_confirm: true,
      });

      expect(mockSupabase.from).toHaveBeenCalledWith("users");
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

      expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
    });

    it("should handle auth user creation failure gracefully", async () => {
      mockSupabase.auth.admin.createUser.mockResolvedValue({
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
      expect(data.results.errors).toContain(
        "Failed to create auth user: User already exists",
      );
    });

    it("should handle database user creation failure", async () => {
      mockSupabase.auth.admin.createUser.mockResolvedValue({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      mockSupabase.from.mockImplementation((table) => {
        if (table === "users") {
          return {
            insert: mock().mockResolvedValue({
              error: { message: "Duplicate key" },
            }),
          };
        }
        return {
          select: mock().mockReturnThis(),
          limit: mock().mockReturnThis(),
          error: null,
        };
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

      expect(data.results.errors).toContain(
        "Failed to create test user: Duplicate key",
      );
    });
  });

  describe("error handling", () => {
    it("should handle validation errors", async () => {
      const consoleErrorSpy = spyOn(console, "error").mockImplementation(
        () => {},
      );

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: JSON.stringify({ skipIfExists: "not-a-boolean" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toBe("Invalid input parameters");

      consoleErrorSpy.mockRestore();
    });

    it("should handle table check failures", async () => {
      mockSupabase.from.mockReturnValue({
        select: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        error: { message: "Connection failed" },
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

      expect(data.success).toBe(true);
      expect(data.message).toBe("Database initialized successfully");
      // Tables that can't be checked are assumed to not exist
    });

    it("should handle storage bucket listing failure", async () => {
      mockSupabase.storage.listBuckets.mockResolvedValue({
        data: null,
        error: { message: "Storage service unavailable" },
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

      expect(data.success).toBe(false);
      expect(data.results.errors).toContain(
        "Failed to list storage buckets: Storage service unavailable",
      );
    });

    it("should handle individual bucket creation failures", async () => {
      mockSupabase.storage.createBucket.mockImplementation((bucket) => {
        if (bucket === "thumbnails") {
          return Promise.resolve({
            data: null,
            error: { message: "Bucket already exists" },
          });
        }
        return Promise.resolve({
          data: { id: bucket },
          error: null,
        });
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

      expect(data.success).toBe(false);
      expect(data.results.errors).toContain(
        "Failed to create bucket thumbnails: Bucket already exists",
      );
    });

    it("should handle JSON parsing errors", async () => {
      const consoleErrorSpy = spyOn(console, "error").mockImplementation(
        () => {},
      );

      const request = new NextRequest(
        "http://localhost/api/v1/setup/database",
        {
          method: "POST",
          body: "invalid-json",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.message).toBe("Failed to initialize database");

      consoleErrorSpy.mockRestore();
    });

    it("should handle unexpected errors gracefully", async () => {
      mockSupabase.from.mockImplementation(() => {
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

      // checkTableExists catches errors internally and returns false
      // So no errors are added to results.errors from table checking
      // Storage operations succeed, so overall success is true
      expect(data.success).toBe(true);
      expect(data.message).toBe("Database initialized successfully");
      expect(data.results.errors).toEqual([]);
      // No tables are marked as created because checkTableExists returns false
      expect(data.results.tablesCreated).toEqual([]);
    });
  });

  describe("partial success scenarios", () => {
    it("should report partial success when some buckets exist", async () => {
      mockSupabase.storage.listBuckets.mockResolvedValue({
        data: [
          { id: "thumbnails", name: "thumbnails" },
          { id: "videos", name: "videos" },
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

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.results.bucketsCreated).toContain("thumbnails");
      expect(data.results.bucketsCreated).toContain("videos");

      // Should still try to create missing buckets
      expect(mockSupabase.storage.createBucket).toHaveBeenCalledWith(
        "characters",
        expect.any(Object),
      );
    });

    it("should continue processing after individual failures", async () => {
      let callCount = 0;
      mockSupabase.storage.createBucket.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({
            data: null,
            error: { message: "Failed to create" },
          });
        }
        return Promise.resolve({
          data: { id: `bucket-${callCount}` },
          error: null,
        });
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

      expect(data.success).toBe(false);
      expect(data.message).toBe(
        "Database initialization completed with errors",
      );
      expect(data.results.errors.length).toBeGreaterThan(0);
      expect(data.results.bucketsCreated.length).toBeGreaterThan(0);
    });
  });
});
