import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createBrowserClient } from "./client";

// Mock the Supabase createClient function
mock.module("@supabase/supabase-js", () => ({
  createClient: mock(() => ({
    from: mock(),
    auth: {
      getSession: mock(),
    },
    storage: {
      from: mock(),
    },
  })),
}));

describe("createBrowserClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables to test defaults
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    };
    mock.restore();
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
    it("should create client with correct auth options", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createBrowserClient();

      expect(mockedCreateClient).toHaveBeenCalledWith(
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

    it("should call createClient exactly once", async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createBrowserClient();

      expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    });

    it("should use the exact environment variable values", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://custom.supabase.co";
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "custom-anon-key-123";

      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;

      createBrowserClient();

      expect(mockedCreateClient).toHaveBeenCalledWith(
        "https://custom.supabase.co",
        "custom-anon-key-123",
        expect.any(Object),
      );
    });
  });

  describe("multiple client creation", () => {
    it("should create new client instance each time", async () => {
      const client1 = createBrowserClient();
      const client2 = createBrowserClient();

      // Each call creates a new instance
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();

      const { createClient } = await import("@supabase/supabase-js");
      const mockedCreateClient = createClient as any;
      expect(mockedCreateClient).toHaveBeenCalledTimes(2);
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
