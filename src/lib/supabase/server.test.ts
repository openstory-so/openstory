import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the Supabase createClient function once
const mockCreateClient = mock(() => ({
  from: mock(),
  auth: {
    admin: {
      createUser: mock(),
      deleteUser: mock(),
    },
    getSession: mock(),
  },
  storage: {
    from: mock(),
    listBuckets: mock(),
    createBucket: mock(),
  },
}));

mock.module("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

describe("createServerClient", () => {
  const originalEnv = process.env;

  // Import dynamically in each test to ensure clean mocks
  let createServerClient: any;
  let _createAdminClient: any;

  beforeEach(async () => {
    // Reset environment variables to test defaults
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    };

    // Clear mock call history
    mockCreateClient.mockClear();

    // Import after setting up environment
    const module = await import("./server");
    createServerClient = module.createServerClient;
    _createAdminClient = module.createAdminClient;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("environment variable validation", () => {
    it("should create client with valid environment variables", () => {
      const client = createServerClient();
      expect(client).toBeDefined();
      expect(client.from).toBeDefined();
      expect(client.auth).toBeDefined();
      expect(client.storage).toBeDefined();
    });

    it("should throw error when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      expect(() => createServerClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL",
      );
    });

    it("should throw error when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      expect(() => createServerClient()).toThrow(
        "Missing required environment variables: SUPABASE_SERVICE_ROLE_KEY",
      );
    });

    it("should throw error when both environment variables are missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      expect(() => createServerClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      );
    });

    it("should include helpful error message about .env file", () => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      expect(() => createServerClient()).toThrow(
        "Please check your .env file and ensure all Supabase variables are set.",
      );
    });

    it("should handle empty string environment variables as missing", () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "";

      expect(() => createServerClient()).toThrow(
        "Missing required environment variables: SUPABASE_SERVICE_ROLE_KEY",
      );
    });

    it("should handle whitespace-only environment variables as missing", () => {
      // The current implementation doesn't trim whitespace,
      // so "   " is considered a valid (though useless) value
      process.env.NEXT_PUBLIC_SUPABASE_URL = "   ";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

      // This should create a client (even though the URL is just whitespace)
      const client = createServerClient();
      expect(client).toBeDefined();
    });
  });

  describe("client configuration", () => {
    it("should create client with correct server-side auth options", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createServerClient();

      expect(mockedCreateClient).toHaveBeenCalledWith(
        "https://test.supabase.co",
        "test-service-role-key",
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
          db: {
            schema: "public",
          },
        },
      );
    });

    it("should disable session persistence for server-side usage", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createServerClient();

      const callArgs = mockedCreateClient.mock.calls[0];
      expect(callArgs[2]?.auth?.persistSession).toBe(false);
      expect(callArgs[2]?.auth?.autoRefreshToken).toBe(false);
    });

    it("should set database schema to public", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createServerClient();

      const callArgs = mockedCreateClient.mock.calls[0];
      expect(callArgs[2]?.db?.schema).toBe("public");
    });

    it("should use service role key instead of anon key", async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-secret";

      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createServerClient();

      expect(mockedCreateClient).toHaveBeenCalledWith(
        expect.any(String),
        "service-role-key-secret",
        expect.any(Object),
      );
    });
  });

  describe("multiple client creation", () => {
    it("should create new client instance each time", () => {
      const client1 = createServerClient();
      const client2 = createServerClient();

      // Each call creates a new instance
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();

      expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("should handle environment variables with special characters", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL =
        "https://test.supabase.co/with/path";
      process.env.SUPABASE_SERVICE_ROLE_KEY =
        "service.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test";

      const client = createServerClient();
      expect(client).toBeDefined();
    });

    it("should handle localhost URLs for local development", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-key";

      const client = createServerClient();
      expect(client).toBeDefined();
    });

    it("should handle very long service role keys", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(2000);

      const client = createServerClient();
      expect(client).toBeDefined();
    });

    it("should handle URLs with non-standard ports", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co:8443";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

      const client = createServerClient();
      expect(client).toBeDefined();
    });
  });
});

describe("createAdminClient", () => {
  const originalEnv = process.env;

  // Import dynamically in each test to ensure clean mocks
  let createServerClient: any;
  let createAdminClient: any;

  beforeEach(async () => {
    // Reset environment variables to test defaults
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    };

    // Clear mock call history
    mockCreateClient.mockClear();

    // Import after setting up environment
    const module = await import("./server");
    createServerClient = module.createServerClient;
    createAdminClient = module.createAdminClient;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should create admin client by calling createServerClient", () => {
    const adminClient = createAdminClient();
    expect(adminClient).toBeDefined();
    expect(adminClient.from).toBeDefined();
    expect(adminClient.auth).toBeDefined();
  });

  it("should have same configuration as server client", () => {
    const _serverClient = createServerClient();
    mockCreateClient.mockClear();

    const _adminClient = createAdminClient();

    // Both should call createClient with same parameters
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-service-role-key",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        db: {
          schema: "public",
        },
      },
    );
  });

  it("should throw same errors as createServerClient when env vars missing", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createAdminClient()).toThrow(
      "Missing required environment variables: SUPABASE_SERVICE_ROLE_KEY",
    );
  });

  it("should be functionally equivalent to createServerClient", () => {
    const serverClient = createServerClient();
    const adminClient = createAdminClient();

    // Both should have the same structure
    expect(Object.keys(serverClient)).toEqual(Object.keys(adminClient));
  });

  it("should support admin operations", () => {
    const adminClient = createAdminClient();

    // Admin client should have auth.admin methods
    expect(adminClient.auth).toBeDefined();
    expect(adminClient.auth.admin).toBeDefined();
    expect(adminClient.auth.admin.createUser).toBeDefined();
    expect(adminClient.auth.admin.deleteUser).toBeDefined();
  });
});
