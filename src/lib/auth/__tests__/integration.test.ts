import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AuthService } from "../service";

// Mock entire supabase module
mock.module("@/lib/supabase/server", () => ({
  createServerClient: mock(),
  createAdminClient: mock(),
}));

describe.skip("Authentication Integration Tests", () => {
  let authService: AuthService;
  let mockSupabase: any;
  let mockAdminClient: any;

  beforeEach(async () => {
    // Reset mocks
    mock.restore();

    // Set up required environment variables for tests
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    // Create comprehensive mock clients
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

    const { createServerClient, createAdminClient } = await import(
      "@/lib/supabase/server"
    );
    (createServerClient as any).mockReturnValue(mockSupabase);
    (createAdminClient as any).mockReturnValue(mockAdminClient);

    authService = new AuthService();
  });

  describe("Full Anonymous to Authenticated Flow", () => {
    it("should handle complete user journey from anonymous to authenticated", async () => {
      // Step 1: Create anonymous session
      const anonymousSession = {
        id: "anon-123",
        data: { sequences: [{ id: 1, title: "Test Sequence" }] },
        expires_at: "2023-12-31T23:59:59Z",
        team_id: null,
        created_at: "2023-01-01T00:00:00Z",
      };

      mockSupabase.single.mockResolvedValueOnce({
        data: anonymousSession,
        error: null,
      });

      const createdSession = await authService.createAnonymousSession({
        sequences: [{ id: 1, title: "Test Sequence" }],
      });

      expect(createdSession).toEqual(anonymousSession);

      // Step 2: Send magic link
      mockSupabase.auth.signInWithOtp.mockResolvedValue({
        data: {},
        error: null,
      });

      const magicLinkResult = await authService.sendMagicLink(
        "user@example.com",
        anonymousSession.id,
      );

      expect(magicLinkResult.success).toBe(true);
      expect(mockSupabase.auth.signInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: {
          emailRedirectTo: expect.stringContaining("anonymousId=anon-123"),
        },
      });

      // Step 3: Simulate user clicking magic link and upgrading session
      // First, mock getting the anonymous session
      mockSupabase.single.mockResolvedValueOnce({
        data: anonymousSession,
        error: null,
      });

      // Mock successful profile creation
      mockAdminClient.upsert.mockResolvedValueOnce({
        data: { id: "user-123", anonymous_id: "anon-123" },
        error: null,
      });

      // Mock successful session deletion
      mockAdminClient.eq.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const upgradeResult =
        await authService.upgradeAnonymousUser("test@example.com");

      expect(upgradeResult.success).toBe(true);
      expect(mockAdminClient.upsert).toHaveBeenCalledWith({
        id: "user-123",
        anonymous_id: "anon-123",
      });

      // Step 4: Verify user can get their session
      const mockUserSession = {
        access_token: "token-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: "user-123", email: "user@example.com" },
      } as any;

      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: mockUserSession },
        error: null,
      });

      const userSession = await authService.getSession();
      expect(userSession).toEqual(mockUserSession);
    });

    it("should handle anonymous session expiry during upgrade", async () => {
      // Mock expired anonymous session
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { code: "PGRST116", message: "No rows found" },
      });

      const result = await authService.upgradeAnonymousUser("test@example.com");

      expect(result).toEqual({
        success: false,
        error: "Anonymous session not found or expired",
      });
    });

    it("should handle duplicate magic link requests", async () => {
      // First request
      mockSupabase.auth.signInWithOtp.mockResolvedValueOnce({
        data: {},
        error: null,
      });

      const firstResult = await authService.sendMagicLink("user@example.com");
      expect(firstResult.success).toBe(true);

      // Second request (should also succeed)
      mockSupabase.auth.signInWithOtp.mockResolvedValueOnce({
        data: {},
        error: null,
      });

      const secondResult = await authService.sendMagicLink("user@example.com");
      expect(secondResult.success).toBe(true);

      // Both should call the same method
      expect(mockSupabase.auth.signInWithOtp).toHaveBeenCalledTimes(2);
    });
  });

  describe("Error Handling Scenarios", () => {
    it("should handle database connection failures gracefully", async () => {
      // Mock the chain: from().insert().select().single()
      mockSupabase.single.mockResolvedValue({
        data: null,
        error: { message: "Connection timeout" },
      });

      await expect(authService.createAnonymousSession()).rejects.toThrow(
        "Failed to create anonymous session: Connection timeout",
      );
    });

    it("should handle magic link service failures", async () => {
      mockSupabase.auth.signInWithOtp.mockResolvedValue({
        data: null,
        error: { message: "Rate limited" },
      });

      const result = await authService.sendMagicLink("user@example.com");

      expect(result).toEqual({
        success: false,
        error: "Rate limited",
      });
    });

    it("should handle partial upgrade failures", async () => {
      // Mock successful anonymous session retrieval
      mockSupabase.single.mockResolvedValue({
        data: { id: "anon-123", data: {} },
        error: null,
      });

      // Mock profile creation failure
      // The upsert method returns a promise directly, not through single()
      mockAdminClient.upsert.mockResolvedValue({
        data: null,
        error: { message: "Profile creation failed" },
      });

      const result = await authService.upgradeAnonymousUser("test@example.com");

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Failed to create user profile: Profile creation failed",
      );
    });
  });

  describe("Cleanup Operations", () => {
    it("should cleanup expired sessions", async () => {
      mockAdminClient.rpc.mockResolvedValue({
        data: 3,
        error: null,
      });

      const deletedCount = await authService.cleanupExpiredSessions();

      expect(deletedCount).toBe(3);
      expect(mockAdminClient.rpc).toHaveBeenCalledWith(
        "cleanup_expired_anonymous_sessions",
      );
    });

    it("should handle cleanup failures", async () => {
      mockAdminClient.rpc.mockResolvedValue({
        data: null,
        error: { message: "Database error" },
      });

      await expect(authService.cleanupExpiredSessions()).rejects.toThrow(
        "Failed to cleanup expired sessions: Database error",
      );
    });
  });

  describe("Session Management", () => {
    it("should handle sign out process", async () => {
      mockSupabase.auth.signOut.mockResolvedValue({ error: null });

      const result = await authService.signOut();

      expect(result.success).toBe(true);
      expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    });

    it("should handle sign out failures", async () => {
      mockSupabase.auth.signOut.mockResolvedValue({
        error: { message: "Sign out failed" },
      });

      const result = await authService.signOut();

      expect(result).toEqual({
        success: false,
        error: "Sign out failed",
      });
    });

    it("should get user profile", async () => {
      const mockProfile = {
        id: "user-123",
        full_name: "Test User",
        email: "user@example.com",
        onboarding_completed: false,
        anonymous_id: null,
        avatar_url: null,
        created_at: "2023-01-01T00:00:00Z",
        updated_at: "2023-01-01T00:00:00Z",
      };

      mockSupabase.single.mockResolvedValue({
        data: mockProfile,
        error: null,
      });

      const profile = await authService.getUserProfile();

      expect(profile).toMatchObject(mockProfile);
      expect(mockSupabase.from).toHaveBeenCalledWith("user_profiles");
      expect(mockSupabase.eq).toHaveBeenCalledWith("id", "user-123");
    });
  });
});
