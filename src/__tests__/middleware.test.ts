import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "../middleware";

// Create mock functions upfront
const mockGetSession = mock();
const mockSupabaseClient = {
  auth: {
    getSession: mockGetSession,
  },
};
const mockCreateMiddlewareClient = mock(() => mockSupabaseClient);

// Mock the module with our mock function
mock.module("@/lib/supabase/middleware", () => ({
  createMiddlewareClient: mockCreateMiddlewareClient,
}));

describe.skip("middleware", () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset mocks
    mockGetSession.mockReset();
    mockCreateMiddlewareClient.mockClear();

    // Reset console spy
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console
    consoleErrorSpy?.mockRestore();
    mock.clearAllMocks();
  });

  describe("Static files and Next.js internals", () => {
    it("should skip middleware for _next paths", async () => {
      const request = new NextRequest(
        "http://localhost:3000/_next/static/chunk.js",
      );

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockCreateMiddlewareClient).not.toHaveBeenCalled();
    });

    it("should skip middleware for static files", async () => {
      const staticPaths = [
        "/favicon.ico",
        "/image.png",
        "/style.css",
        "/script.js",
      ];

      for (const path of staticPaths) {
        const request = new NextRequest(`http://localhost:3000${path}`);
        const response = await middleware(request);
        expect(response).toBeInstanceOf(NextResponse);
        // For files matching the pattern, middleware returns early without auth checks
        expect(mockGetSession).not.toHaveBeenCalled();
        mockGetSession.mockClear();
      }
    });
  });

  describe("Public routes", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });
    });

    it("should allow access to home page without authentication", async () => {
      const request = new NextRequest("http://localhost:3000/");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockGetSession).toHaveBeenCalled();
      expect(response.headers.get("location")).toBeNull();
    });

    it("should allow access to login page without authentication", async () => {
      const request = new NextRequest("http://localhost:3000/login");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockGetSession).toHaveBeenCalled();
      expect(response.headers.get("location")).toBeNull();
    });

    it("should allow access to pricing page without authentication", async () => {
      const request = new NextRequest("http://localhost:3000/pricing");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockGetSession).toHaveBeenCalled();
      expect(response.headers.get("location")).toBeNull();
    });
  });

  describe("Protected routes", () => {
    it("should redirect to login when no session exists", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      const protectedPaths = [
        "/dashboard",
        "/dashboard/settings",
        "/sequences",
        "/sequences/123",
        "/teams",
        "/teams/abc",
      ];

      for (const path of protectedPaths) {
        const request = new NextRequest(`http://localhost:3000${path}`);
        const response = await middleware(request);

        expect(response.status).toBe(307);
        const location = response.headers.get("location");
        expect(location).toContain("http://localhost:3000/login");
        expect(location).toContain(`redirectTo=${encodeURIComponent(path)}`);
      }
    });

    it("should allow access with valid session", async () => {
      const mockSession = {
        user: { id: "user-123", email: "test@example.com" },
        access_token: "token-123",
        refresh_token: "refresh-123",
      };

      mockGetSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const request = new NextRequest("http://localhost:3000/dashboard");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockGetSession).toHaveBeenCalled();
      // Should not redirect
      expect(response.headers.get("location")).toBeNull();
    });
  });

  describe("Auth routes with existing session", () => {
    it("should redirect to dashboard when accessing login with session", async () => {
      const mockSession = {
        user: { id: "user-123", email: "test@example.com" },
        access_token: "token-123",
        refresh_token: "refresh-123",
      };

      mockGetSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const authRoutes = ["/login", "/signup"];

      for (const route of authRoutes) {
        const request = new NextRequest(`http://localhost:3000${route}`);
        const response = await middleware(request);

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
          "http://localhost:3000/dashboard",
        );
      }
    });
  });

  describe("Auth callback route", () => {
    it("should always allow access to auth callback", async () => {
      // Test without session
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      let request = new NextRequest("http://localhost:3000/auth/callback");
      let response = await middleware(request);
      expect(response).toBeInstanceOf(NextResponse);
      expect(response.headers.get("location")).toBeNull();

      // Test with session
      const mockSession = {
        user: { id: "user-123", email: "test@example.com" },
        access_token: "token-123",
        refresh_token: "refresh-123",
      };

      mockGetSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      request = new NextRequest("http://localhost:3000/auth/callback");
      response = await middleware(request);
      expect(response).toBeInstanceOf(NextResponse);
      expect(response.headers.get("location")).toBeNull();
    });
  });

  describe("API routes", () => {
    it("should not check authentication for API routes", async () => {
      const request = new NextRequest("http://localhost:3000/api/test");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockCreateMiddlewareClient).not.toHaveBeenCalled();
    });

    it("should skip middleware for API v1 routes", async () => {
      const request = new NextRequest("http://localhost:3000/api/v1/sequences");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(mockCreateMiddlewareClient).not.toHaveBeenCalled();
    });
  });

  describe("Redirect with original URL", () => {
    it("should include redirect query param for protected routes", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      const request = new NextRequest(
        "http://localhost:3000/dashboard/settings",
      );
      const response = await middleware(request);

      expect(response.status).toBe(307);
      const location = response.headers.get("location");
      expect(location).toContain("/login?redirectTo=%2Fdashboard%2Fsettings");
    });

    it("should not include redirect param for auth routes", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      const request = new NextRequest("http://localhost:3000/signup");
      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(response.headers.get("location")).toBeNull();
    });
  });

  describe("Error handling", () => {
    it("should handle Supabase connection failures for public routes", async () => {
      mockGetSession.mockRejectedValue(new Error("Network error"));

      const request = new NextRequest("http://localhost:3000/");

      const response = await middleware(request);

      expect(response).toBeInstanceOf(NextResponse);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Middleware error:",
        expect.any(Error),
      );
      // Should not redirect for public routes
      expect(response.headers.get("location")).toBeNull();
    });

    it("should redirect to login on Supabase errors for protected routes", async () => {
      mockGetSession.mockRejectedValue(new Error("Database connection failed"));

      const request = new NextRequest("http://localhost:3000/dashboard");

      const response = await middleware(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/login",
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Middleware error:",
        expect.any(Error),
      );
    });
  });
});
