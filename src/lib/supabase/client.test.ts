import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the Supabase createClient function once
const mockCreateClient = mock(() => ({
  from: mock(),
  auth: {
    getSession: mock(),
    onAuthStateChange: mock(),
  },
  storage: {
    from: mock(),
  },
}));

mock.module("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

describe("createBrowserClient", () => {
  const originalEnv = process.env;

  // Import dynamically in each test to ensure clean mocks
  let createBrowserClient: any;

  beforeEach(async () => {
    // Reset environment variables to test defaults
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    };

    // Clear mock call history
    mockCreateClient.mockClear();

    // Import after setting up environment
    const module = await import("./client");
    createBrowserClient = module.createBrowserClient;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("environment variable validation", () => {
    it("should create client with valid environment variables", () => {
      const client = createBrowserClient();
      expect(client).toBeDefined();
      expect(client.from).toBeDefined();
      expect(client.auth).toBeDefined();
      expect(client.storage).toBeDefined();
    });

    it("should throw error when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      expect(() => createBrowserClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL",
      );
    });

    it("should throw error when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      expect(() => createBrowserClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_ANON_KEY",
      );
    });

    it("should throw error when both environment variables are missing", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      expect(() => createBrowserClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY",
      );
    });

    it("should include helpful error message about .env file", () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      expect(() => createBrowserClient()).toThrow(
        "Please check your .env file and ensure all Supabase variables are set.",
      );
    });

    it("should handle empty string environment variables as missing", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "";

      expect(() => createBrowserClient()).toThrow(
        "Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL",
      );
    });
  });

  describe("client configuration", () => {
    it("should create client with correct auth options", () => {
      createBrowserClient();

      expect(mockCreateClient).toHaveBeenCalledWith(
        "https://test.supabase.co",
        "test-anon-key",
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        },
      );
    });

    it("should call createClient exactly once", () => {
      createBrowserClient();

      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it("should use the exact environment variable values", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://custom.supabase.co";
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "custom-anon-key-123";

      createBrowserClient();

      expect(mockCreateClient).toHaveBeenCalledWith(
        "https://custom.supabase.co",
        "custom-anon-key-123",
        expect.any(Object),
      );
    });
  });

  describe("multiple client creation", () => {
    it("should create new client instance each time", () => {
      const client1 = createBrowserClient();
      const client2 = createBrowserClient();

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
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test";

      const client = createBrowserClient();
      expect(client).toBeDefined();
    });

    it("should handle URL with port number", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-anon-key";

      const client = createBrowserClient();
      expect(client).toBeDefined();
    });

    it("should handle very long keys", () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "a".repeat(1000);

      const client = createBrowserClient();
      expect(client).toBeDefined();
    });
  });
});
