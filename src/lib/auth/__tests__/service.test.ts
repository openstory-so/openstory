import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AuthService } from "../service";

// Create all mock functions upfront for Supabase client
const mockSupabaseFrom = mock();
const mockSupabaseInsert = mock();
const mockSupabaseSelect = mock();
const mockSupabaseEq = mock();
const mockSupabaseGt = mock();
const mockSupabaseUpdate = mock();
const mockSupabaseDelete = mock();
const mockSupabaseUpsert = mock();
const mockSupabaseSingle = mock();
const mockSupabaseRpc = mock();

// Auth methods
const mockSignInWithOtp = mock();
const mockGetSession = mock();
const mockSignOut = mock();

// Admin client methods
const mockAdminFrom = mock();
const mockAdminUpsert = mock();
const mockAdminDelete = mock();
const mockAdminSelect = mock();
const mockAdminEq = mock();
const mockAdminSingle = mock();
const mockAdminRpc = mock();

// Create the mock Supabase client structure
const mockSupabaseClient = {
  from: mockSupabaseFrom,
  rpc: mockSupabaseRpc,
  auth: {
    signInWithOtp: mockSignInWithOtp,
    getSession: mockGetSession,
    signOut: mockSignOut,
  },
  // Helper methods for chaining (not actual Supabase methods)
  insert: mockSupabaseInsert,
  select: mockSupabaseSelect,
  eq: mockSupabaseEq,
  gt: mockSupabaseGt,
  update: mockSupabaseUpdate,
  delete: mockSupabaseDelete,
  upsert: mockSupabaseUpsert,
  single: mockSupabaseSingle,
};

// Create the mock admin client structure
const mockAdminClient = {
  from: mockAdminFrom,
  rpc: mockAdminRpc,
  // Helper methods for chaining
  upsert: mockAdminUpsert,
  delete: mockAdminDelete,
  select: mockAdminSelect,
  eq: mockAdminEq,
  single: mockAdminSingle,
};

// Mock constructor functions
const mockCreateServerClient = mock(() => mockSupabaseClient);
const mockCreateAdminClient = mock(() => mockAdminClient);

// Mock the Supabase module
mock.module("@/lib/supabase/server", () => ({
  createServerClient: mockCreateServerClient,
  createAdminClient: mockCreateAdminClient,
}));

// Mock crypto.randomUUID
const mockRandomUUID = mock(() => "mock-uuid-123");
mock.module("crypto", () => ({
  randomUUID: mockRandomUUID,
}));

// Helper function to setup chainable methods
function setupChainableMocks() {
  // Reset all mocks
  mockSupabaseFrom.mockReset();
  mockSupabaseInsert.mockReset();
  mockSupabaseSelect.mockReset();
  mockSupabaseEq.mockReset();
  mockSupabaseGt.mockReset();
  mockSupabaseUpdate.mockReset();
  mockSupabaseDelete.mockReset();
  mockSupabaseUpsert.mockReset();
  mockSupabaseSingle.mockReset();
  mockSupabaseRpc.mockReset();
  mockSignInWithOtp.mockReset();
  mockGetSession.mockReset();
  mockSignOut.mockReset();

  mockAdminFrom.mockReset();
  mockAdminUpsert.mockReset();
  mockAdminDelete.mockReset();
  mockAdminSelect.mockReset();
  mockAdminEq.mockReset();
  mockAdminSingle.mockReset();
  mockAdminRpc.mockReset();

  // Setup chaining behavior for Supabase client
  mockSupabaseFrom.mockReturnValue(mockSupabaseClient);
  mockSupabaseInsert.mockReturnValue(mockSupabaseClient);
  mockSupabaseSelect.mockReturnValue(mockSupabaseClient);
  mockSupabaseEq.mockReturnValue(mockSupabaseClient);
  mockSupabaseGt.mockReturnValue(mockSupabaseClient);
  mockSupabaseUpdate.mockReturnValue(mockSupabaseClient);
  mockSupabaseDelete.mockReturnValue(mockSupabaseClient);
  mockSupabaseUpsert.mockReturnValue(mockSupabaseClient);

  // Setup chaining behavior for admin client
  mockAdminFrom.mockReturnValue(mockAdminClient);
  mockAdminUpsert.mockReturnValue(mockAdminClient);
  mockAdminDelete.mockReturnValue({
    eq: mock().mockResolvedValue({ data: null, error: null }),
  });
  mockAdminSelect.mockReturnValue(mockAdminClient);
  mockAdminEq.mockReturnValue(mockAdminClient);
}

describe.skip("AuthService", () => {
  let authService: AuthService;

  beforeEach(() => {
    // Setup chainable mocks
    setupChainableMocks();

    // Clear constructor mocks
    mockCreateServerClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockRandomUUID.mockClear();

    authService = new AuthService();
  });

  afterEach(() => {
    mock.clearAllMocks();
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

      mockSupabaseSingle.mockResolvedValue({
        data: mockSession,
        error: null,
      });

      const result = await authService.createAnonymousSession({ test: "data" });

      expect(mockSupabaseFrom).toHaveBeenCalledWith("anonymous_sessions");
      expect(mockSupabaseInsert).toHaveBeenCalledWith({
        id: expect.any(String),
        data: { test: "data" },
      });
      expect(result).toEqual(mockSession);
    });

    it("should throw error when creation fails", async () => {
      mockSupabaseSingle.mockResolvedValue({
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

      mockSupabaseSingle.mockResolvedValue({
        data: mockSession,
        error: null,
      });

      const result = await authService.getAnonymousSession("session-123");

      expect(mockSupabaseFrom).toHaveBeenCalledWith("anonymous_sessions");
      expect(mockSupabaseEq).toHaveBeenCalledWith("id", "session-123");
      expect(result).toEqual(mockSession);
    });

    it("should return null when session not found", async () => {
      mockSupabaseSingle.mockResolvedValue({
        data: null,
        error: { code: "PGRST116", message: "No rows found" },
      });

      const result = await authService.getAnonymousSession("nonexistent");

      expect(result).toBeNull();
    });

    it("should throw error for other database errors", async () => {
      mockSupabaseSingle.mockResolvedValue({
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

      mockSignInWithOtp.mockResolvedValue({
        data: {},
        error: null,
      });

      const result = await authService.sendMagicLink("user@example.com");

      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: {
          emailRedirectTo: "http://localhost:3000/auth/callback",
        },
      });
      expect(result).toEqual({ success: true });
    });

    it("should send magic link with anonymous ID", async () => {
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

      mockSignInWithOtp.mockResolvedValue({
        data: {},
        error: null,
      });

      const result = await authService.sendMagicLink(
        "user@example.com",
        "anonymous-123",
      );

      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: {
          emailRedirectTo:
            "http://localhost:3000/auth/callback?anonymousId=anonymous-123",
        },
      });
      expect(result).toEqual({ success: true });
    });

    it("should handle magic link errors", async () => {
      mockSignInWithOtp.mockResolvedValue({
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
      mockSupabaseSingle.mockResolvedValueOnce({
        data: mockSession,
        error: null,
      });

      // Mock profile upsert
      mockAdminSingle.mockResolvedValueOnce({
        data: { id: "user-123" },
        error: null,
      });

      // Mock session deletion - need to reset the chain for this specific test
      mockAdminDelete.mockReturnValueOnce({
        eq: mock().mockResolvedValue({ data: null, error: null }),
      });

      const result = await authService.upgradeAnonymousSession(
        "user-123",
        "anonymous-123",
      );

      expect(mockAdminFrom).toHaveBeenCalledWith("user_profiles");
      expect(mockAdminUpsert).toHaveBeenCalledWith({
        id: "user-123",
        anonymous_id: "anonymous-123",
      });
      expect(result).toEqual({ success: true });
    });

    it("should handle non-existent anonymous session", async () => {
      // Mock getAnonymousSession returning null
      mockSupabaseSingle.mockResolvedValue({
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
        user: {
          id: "user-123",
          email: "user@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2023-01-01T00:00:00Z",
        },
      };

      mockGetSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const result = await authService.getSession();

      expect(result).toEqual(mockSession);
    });

    it("should return null when no session", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      const result = await authService.getSession();

      expect(result).toBeNull();
    });

    it("should handle session errors gracefully", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: { message: "Session error" },
      });

      const result = await authService.getSession();

      expect(result).toBeNull();
    });
  });

  describe("signOut", () => {
    it("should sign out successfully", async () => {
      mockSignOut.mockResolvedValue({
        error: null,
      });

      const result = await authService.signOut();

      expect(mockSignOut).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("should handle sign out errors", async () => {
      mockSignOut.mockResolvedValue({
        error: { message: "Sign out failed" },
      });

      const result = await authService.signOut();

      expect(result).toEqual({ success: false, error: "Sign out failed" });
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("should cleanup expired sessions", async () => {
      mockAdminRpc.mockResolvedValue({
        data: 5,
        error: null,
      });

      const result = await authService.cleanupExpiredSessions();

      expect(mockAdminRpc).toHaveBeenCalledWith(
        "cleanup_expired_anonymous_sessions",
      );
      expect(result).toBe(5);
    });

    it("should handle cleanup errors", async () => {
      mockAdminRpc.mockResolvedValue({
        data: null,
        error: { message: "Cleanup failed" },
      });

      await expect(authService.cleanupExpiredSessions()).rejects.toThrow(
        "Failed to cleanup expired sessions: Cleanup failed",
      );
    });
  });
});
