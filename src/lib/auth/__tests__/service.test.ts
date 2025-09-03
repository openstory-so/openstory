import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AuthService } from "../service";

// Mock the Supabase clients
mock.module("@/lib/supabase/server", () => ({
  createServerClient: mock(),
  createAdminClient: mock(),
}));

// Mock crypto.randomUUID
mock.module("crypto", () => ({
  randomUUID: mock(() => "mock-uuid-123"),
}));

describe("AuthService", () => {
  let authService: AuthService;
  let mockSupabase: any;
  let mockAdminClient: any;

  beforeEach(async () => {
    // Create mock clients
    mockSupabase = {
      from: mock().mockReturnThis(),
      insert: mock().mockReturnThis(),
      select: mock().mockReturnThis(),
      eq: mock().mockReturnThis(),
      gt: mock().mockReturnThis(),
      update: mock().mockReturnThis(),
      delete: mock().mockReturnThis(),
      upsert: mock().mockReturnThis(),
      single: mock(),
      rpc: mock(),
      auth: {
        signInWithOtp: mock(),
        getSession: mock(),
        signOut: mock(),
      },
    };

    mockAdminClient = {
      from: mock().mockReturnThis(),
      upsert: mock().mockReturnThis(),
      delete: mock().mockReturnThis(),
      select: mock().mockReturnThis(),
      eq: mock().mockReturnThis(),
      single: mock(),
      rpc: mock(),
    };

    // Make sure delete chain works properly
    mockAdminClient.delete.mockReturnValue({
      eq: mock().mockResolvedValue({ data: null, error: null }),
    });

    // Mock the imports
    const { createServerClient, createAdminClient } = await import(
      "@/lib/supabase/server"
    );
    (createServerClient as any).mockReturnValue(mockSupabase);
    (createAdminClient as any).mockReturnValue(mockAdminClient);

    authService = new AuthService();
  });

  afterEach(() => {
    mock.restore();
  });

  describe("createAnonymousSession", () => {
    it("should create an anonymous session successfully", async () => {
      const mockSession = {
        id: "mock-uuid-123",
        data: { test: "data" },
        created_at: "2023-01-01T00:00:00Z",
        expires_at: "2023-01-31T00:00:00Z",
        team_id: null,
      };

      mockSupabase.single.mockResolvedValue({
        data: mockSession,
        error: null,
      });

      const result = await authService.createAnonymousSession({ test: "data" });

      expect(mockSupabase.from).toHaveBeenCalledWith("anonymous_sessions");
      expect(mockSupabase.insert).toHaveBeenCalledWith({
        id: expect.any(String),
        data: { test: "data" },
      });
      expect(result).toEqual(mockSession);
    });

    it("should throw error when creation fails", async () => {
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { message: "Database error" },
      });

      await expect(authService.createAnonymousSession()).rejects.toThrow(
        "Failed to create anonymous session: Database error",
      );
    });
  });

  describe("getAnonymousSession", () => {
    it("should get anonymous session successfully", async () => {
      const mockSession = {
        id: "session-123",
        data: {},
        expires_at: "2023-12-31T23:59:59Z",
        team_id: null,
        created_at: "2023-01-01T00:00:00Z",
      };

      mockSupabase.single.mockResolvedValue({
        data: mockSession,
        error: null,
      });

      const result = await authService.getAnonymousSession("session-123");

      expect(mockSupabase.from).toHaveBeenCalledWith("anonymous_sessions");
      expect(mockSupabase.eq).toHaveBeenCalledWith("id", "session-123");
      expect(result).toEqual(mockSession);
    });

    it("should return null when session not found", async () => {
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: "PGRST116", message: "No rows found" },
      });

      const result = await authService.getAnonymousSession("nonexistent");

      expect(result).toBeNull();
    });

    it("should throw error for other database errors", async () => {
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: "OTHER_ERROR", message: "Database error" },
      });

      await expect(
        authService.getAnonymousSession("session-123"),
      ).rejects.toThrow("Failed to get anonymous session: Database error");
    });
  });

  describe("sendMagicLink", () => {
    it("should send magic link successfully", async () => {
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      mockSupabase.auth.signInWithOtp.mockResolvedValue({
        data: {},
        error: null,
      });

      const result = await authService.sendMagicLink("user@example.com");

      expect(mockSupabase.auth.signInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: {
          emailRedirectTo: "http://localhost:3000/auth/callback",
        },
      });
      expect(result).toEqual({ success: true });
    });

    it("should send magic link with anonymous ID", async () => {
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      mockSupabase.auth.signInWithOtp.mockResolvedValue({
        data: {},
        error: null,
      });

      const result = await authService.sendMagicLink(
        "user@example.com",
        "anonymous-123",
      );

      expect(mockSupabase.auth.signInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: {
          emailRedirectTo:
            "http://localhost:3000/auth/callback?anonymousId=anonymous-123",
        },
      });
      expect(result).toEqual({ success: true });
    });

    it("should handle magic link errors", async () => {
      mockSupabase.auth.signInWithOtp.mockResolvedValue({
        data: null,
        error: { message: "Invalid email" },
      });

      const result = await authService.sendMagicLink("invalid-email");

      expect(result).toEqual({ success: false, error: "Invalid email" });
    });
  });

  describe("upgradeAnonymousSession", () => {
    it("should upgrade anonymous session successfully", async () => {
      const mockSession = {
        id: "anonymous-123",
        data: { work: "data" },
        expires_at: "2023-12-31T23:59:59Z",
        team_id: null,
      };

      // Mock getAnonymousSession
      mockSupabase.single.mockResolvedValueOnce({
        data: mockSession,
        error: null,
      });

      // Mock profile upsert
      mockAdminClient.single.mockResolvedValueOnce({
        data: { id: "user-123" },
        error: null,
      });

      // Mock session deletion - need to reset the chain for this specific test
      mockAdminClient.delete.mockReturnValueOnce({
        eq: mock().mockResolvedValue({ data: null, error: null }),
      });

      const result = await authService.upgradeAnonymousSession(
        "user-123",
        "anonymous-123",
      );

      expect(mockAdminClient.from).toHaveBeenCalledWith("user_profiles");
      expect(mockAdminClient.upsert).toHaveBeenCalledWith({
        id: "user-123",
        anonymous_id: "anonymous-123",
      });
      expect(result).toEqual({ success: true });
    });

    it("should handle non-existent anonymous session", async () => {
      // Mock getAnonymousSession returning null
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: "PGRST116" },
      });

      const result = await authService.upgradeAnonymousSession(
        "user-123",
        "nonexistent",
      );

      expect(result).toEqual({
        success: false,
        error: "Anonymous session not found or expired",
      });
    });
  });

  describe("getSession", () => {
    it("should get current session successfully", async () => {
      const mockSession = {
        access_token: "token-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: "user-123", email: "user@example.com" },
      } as any;

      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const result = await authService.getSession();

      expect(result).toEqual(mockSession);
    });

    it("should return null when no session", async () => {
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      const result = await authService.getSession();

      expect(result).toBeNull();
    });

    it("should handle session errors gracefully", async () => {
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: null },
        error: { message: "Session error" },
      });

      const result = await authService.getSession();

      expect(result).toBeNull();
    });
  });

  describe("signOut", () => {
    it("should sign out successfully", async () => {
      mockSupabase.auth.signOut.mockResolvedValue({
        error: null,
      });

      const result = await authService.signOut();

      expect(mockSupabase.auth.signOut).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("should handle sign out errors", async () => {
      mockSupabase.auth.signOut.mockResolvedValue({
        error: { message: "Sign out failed" },
      });

      const result = await authService.signOut();

      expect(result).toEqual({ success: false, error: "Sign out failed" });
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("should cleanup expired sessions", async () => {
      mockAdminClient.rpc.mockResolvedValue({
        data: 5,
        error: null,
      });

      const result = await authService.cleanupExpiredSessions();

      expect(mockAdminClient.rpc).toHaveBeenCalledWith(
        "cleanup_expired_anonymous_sessions",
      );
      expect(result).toBe(5);
    });

    it("should handle cleanup errors", async () => {
      mockAdminClient.rpc.mockResolvedValue({
        data: null,
        error: { message: "Cleanup failed" },
      });

      await expect(authService.cleanupExpiredSessions()).rejects.toThrow(
        "Failed to cleanup expired sessions: Cleanup failed",
      );
    });
  });
});
