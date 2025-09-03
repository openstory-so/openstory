import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { DELETE, GET } from "../session/route";

// Create mock functions first
const mockGetSession = mock();
const mockGetUserProfile = mock();
const mockSignOut = mock();

// Create the mock AuthService constructor
const MockAuthService = mock(() => ({
  getSession: mockGetSession,
  getUserProfile: mockGetUserProfile,
  signOut: mockSignOut,
}));

// Mock the module with our mock functions
mock.module("@/lib/auth/service", () => ({
  AuthService: MockAuthService,
}));

describe.skip("/api/v1/auth/session", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockGetSession.mockReset();
    mockGetUserProfile.mockReset();
    mockSignOut.mockReset();
    MockAuthService.mockClear();
  });

  afterEach(() => {
    mock.restore();
  });

  describe("GET /api/v1/auth/session", () => {
    it("should return null session for unauthenticated users", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        session: null,
        user: null,
        isAuthenticated: false,
      });
      expect(mockGetSession).toHaveBeenCalled();
      expect(mockGetUserProfile).not.toHaveBeenCalled();
    });

    it("should return session and profile for authenticated users", async () => {
      const mockSession = {
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_at: 1234567890,
        user: {
          id: "user-123",
          email: "test@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2023-01-01T00:00:00Z",
        },
      };

      const mockProfile = {
        id: "user-123",
        email: "test@example.com",
        display_name: "Test User",
        avatar_url: "https://example.com/avatar.jpg",
        created_at: "2023-01-01T00:00:00Z",
        updated_at: "2023-01-01T00:00:00Z",
      };

      mockGetSession.mockResolvedValue(mockSession);
      mockGetUserProfile.mockResolvedValue(mockProfile);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        session: {
          access_token: "mock-access-token",
          refresh_token: "mock-refresh-token",
          expires_at: 1234567890,
          user: mockSession.user,
        },
        profile: mockProfile,
        isAuthenticated: true,
      });
      expect(mockGetSession).toHaveBeenCalled();
      expect(mockGetUserProfile).toHaveBeenCalledWith("user-123");
    });

    it("should handle missing user profile gracefully", async () => {
      const mockSession = {
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_at: 1234567890,
        user: {
          id: "user-456",
          email: "newuser@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2023-01-01T00:00:00Z",
        },
      };

      mockGetSession.mockResolvedValue(mockSession);
      mockGetUserProfile.mockResolvedValue(null);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        session: {
          access_token: "mock-access-token",
          refresh_token: "mock-refresh-token",
          expires_at: 1234567890,
          user: mockSession.user,
        },
        profile: null,
        isAuthenticated: true,
      });
      expect(mockGetSession).toHaveBeenCalled();
      expect(mockGetUserProfile).toHaveBeenCalledWith("user-456");
    });

    it("should handle getSession errors", async () => {
      mockGetSession.mockRejectedValue(new Error("Database connection failed"));

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Database connection failed");
    });

    it("should handle getUserProfile errors", async () => {
      const mockSession = {
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_at: 1234567890,
        user: {
          id: "user-789",
          email: "error@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2023-01-01T00:00:00Z",
        },
      };

      mockGetSession.mockResolvedValue(mockSession);
      mockGetUserProfile.mockRejectedValue(new Error("Profile fetch failed"));

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Profile fetch failed");
    });
  });

  describe("DELETE /api/v1/auth/session", () => {
    it("should sign out successfully", async () => {
      mockSignOut.mockResolvedValue({ success: true });

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "DELETE",
        },
      );

      const response = await DELETE(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.message).toBe("Signed out successfully");
      expect(mockSignOut).toHaveBeenCalled();
    });

    it("should handle sign out failure", async () => {
      mockSignOut.mockResolvedValue({
        success: false,
        error: "Failed to invalidate session",
      });

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "DELETE",
        },
      );

      const response = await DELETE(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to invalidate session");
      expect(mockSignOut).toHaveBeenCalled();
    });

    it("should handle sign out without error message", async () => {
      mockSignOut.mockResolvedValue({
        success: false,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "DELETE",
        },
      );

      const response = await DELETE(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to sign out");
    });

    it("should handle sign out exceptions", async () => {
      mockSignOut.mockRejectedValue(new Error("Network error occurred"));

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "DELETE",
        },
      );

      const response = await DELETE(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error occurred");
    });

    it("should handle non-Error exceptions", async () => {
      mockSignOut.mockRejectedValue("Unknown error");

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "DELETE",
        },
      );

      const response = await DELETE(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to sign out");
    });
  });

  describe("Edge cases", () => {
    it("should handle session with minimal user data", async () => {
      const mockSession = {
        access_token: "token",
        refresh_token: "refresh",
        expires_at: 1234567890,
        user: {
          id: "minimal-user",
        },
      };

      mockGetSession.mockResolvedValue(mockSession);
      mockGetUserProfile.mockResolvedValue(null);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data.session.user.id).toBe("minimal-user");
    });

    it("should handle session with expired token timestamp", async () => {
      const mockSession = {
        access_token: "expired-token",
        refresh_token: "refresh",
        expires_at: 0, // Already expired
        user: {
          id: "user-expired",
          email: "expired@example.com",
        },
      };

      mockGetSession.mockResolvedValue(mockSession);
      mockGetUserProfile.mockResolvedValue(null);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/auth/session",
        {
          method: "GET",
        },
      );

      const response = await GET(request);
      const result = await response.json();

      // The route should still return the session data,
      // letting the client handle the expired state
      expect(response.status).toBe(200);
      expect(result.success).toBe(true);
      expect(result.data.session.expires_at).toBe(0);
      expect(result.data.isAuthenticated).toBe(true);
    });
  });
});
