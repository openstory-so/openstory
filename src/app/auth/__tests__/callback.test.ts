import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Create mock functions at module level
const mockUpgradeAnonymousSession = mock();
const mockGetUserProfile = mock();
const mockUpsertUserProfile = mock();
const mockExchangeCodeForSession = mock();
const mockRedirect = mock();

// Set up module mocks before any imports
mock.module("@/lib/auth/service", () => ({
  AuthService: mock(() => ({
    upgradeAnonymousSession: mockUpgradeAnonymousSession,
    getUserProfile: mockGetUserProfile,
    upsertUserProfile: mockUpsertUserProfile,
  })),
}));

mock.module("@/lib/supabase/server", () => ({
  createServerClient: mock(() => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
    },
  })),
}));

mock.module("next/server", () => ({
  NextRequest: class NextRequest {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  },
  NextResponse: {
    redirect: mockRedirect,
  },
}));

// Create a reference to NextRequest class for use in tests
class MockNextRequest {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}

// Import the route handler after mocks are set up
import { GET } from "../callback/route";

describe("/auth/callback", () => {
  beforeEach(() => {
    // Clear all mock calls and implementations
    mockUpgradeAnonymousSession.mockClear();
    mockGetUserProfile.mockClear();
    mockUpsertUserProfile.mockClear();
    mockExchangeCodeForSession.mockClear();
    mockRedirect.mockClear();

    // Set default redirect behavior
    mockRedirect.mockImplementation((url: URL) => ({
      status: 302,
      headers: new Headers({
        Location: url.toString(),
      }),
    }));
  });

  afterEach(() => {
    // Clear mocks after each test
    mockUpgradeAnonymousSession.mockClear();
    mockGetUserProfile.mockClear();
    mockUpsertUserProfile.mockClear();
    mockExchangeCodeForSession.mockClear();
    mockRedirect.mockClear();
  });

  describe("Successful authentication flow", () => {
    it("should exchange code for session and redirect to dashboard", async () => {
      const mockSession = {
        session: {
          user: {
            id: "user-123",
            email: "test@example.com",
            user_metadata: {
              full_name: "Test User",
              avatar_url: "https://example.com/avatar.jpg",
            },
          },
        },
      };

      const mockProfile = {
        id: "user-123",
        full_name: "Test User",
        avatar_url: "https://example.com/avatar.jpg",
        onboarding_completed: true,
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(mockProfile);

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=test-code",
      ) as any;

      const _response = await GET(request);

      expect(mockExchangeCodeForSession).toHaveBeenCalledWith("test-code");
      expect(mockGetUserProfile).toHaveBeenCalledWith("user-123");
      expect(mockUpsertUserProfile).not.toHaveBeenCalled();
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should create user profile on first login", async () => {
      const mockSession = {
        session: {
          user: {
            id: "new-user-456",
            email: "newuser@example.com",
            user_metadata: {},
          },
        },
      };

      const mockNewProfile = {
        id: "new-user-456",
        full_name: "newuser",
        avatar_url: null,
        onboarding_completed: false,
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(null);
      mockUpsertUserProfile.mockResolvedValue(mockNewProfile);

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=new-user-code",
      ) as any;

      const _response = await GET(request);

      expect(mockGetUserProfile).toHaveBeenCalledWith("new-user-456");
      expect(mockUpsertUserProfile).toHaveBeenCalledWith({
        id: "new-user-456",
        anonymous_id: null,
        full_name: "newuser",
        avatar_url: null,
        onboarding_completed: false,
      });
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should upgrade anonymous session when anonymousId is provided", async () => {
      const mockSession = {
        session: {
          user: {
            id: "user-789",
            email: "upgrade@example.com",
            user_metadata: {
              full_name: "Upgrade User",
            },
          },
        },
      };

      const mockProfile = {
        id: "user-789",
        full_name: "Upgrade User",
        onboarding_completed: false,
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(mockProfile);
      mockUpgradeAnonymousSession.mockResolvedValue({
        success: true,
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=upgrade-code&anonymousId=anon-session-123",
      ) as any;

      const _response = await GET(request);

      expect(mockUpgradeAnonymousSession).toHaveBeenCalledWith(
        "user-789",
        "anon-session-123",
      );
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should handle custom redirectTo parameter", async () => {
      const mockSession = {
        session: {
          user: {
            id: "user-redirect",
            email: "redirect@example.com",
          },
        },
      };

      const mockProfile = {
        id: "user-redirect",
        full_name: "Redirect User",
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(mockProfile);

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=redirect-code&redirectTo=/profile/settings",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/profile/settings");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should continue auth flow even if anonymous session upgrade fails", async () => {
      const mockSession = {
        session: {
          user: {
            id: "user-fail-upgrade",
            email: "failupgrade@example.com",
          },
        },
      };

      const mockProfile = {
        id: "user-fail-upgrade",
        full_name: "Fail Upgrade User",
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(mockProfile);
      mockUpgradeAnonymousSession.mockResolvedValue({
        success: false,
        error: "Failed to transfer data",
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=fail-upgrade-code&anonymousId=anon-fail-123",
      ) as any;

      const _response = await GET(request);

      expect(mockUpgradeAnonymousSession).toHaveBeenCalledWith(
        "user-fail-upgrade",
        "anon-fail-123",
      );
      // Should still redirect successfully despite upgrade failure
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });
  });

  describe("Error handling", () => {
    it("should redirect to login with error when code exchange fails", async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: null,
        error: { message: "Invalid or expired code" },
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=invalid-code",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/login");
      expect(redirectCall.toString()).toContain("error=Authentication");
    });

    it("should redirect to login when no user is found in session", async () => {
      const mockSession = {
        session: {
          user: null,
        },
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=no-user-code",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/login");
      expect(redirectCall.toString()).toContain("error=No%20user%20found");
    });

    it("should handle missing code parameter", async () => {
      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback",
      ) as any;

      const _response = await GET(request);

      expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/login");
      expect(redirectCall.toString()).toContain(
        "error=Invalid%20authentication%20request",
      );
    });

    it("should handle exceptions during authentication process", async () => {
      mockExchangeCodeForSession.mockRejectedValue(new Error("Network error"));

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=error-code",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/login");
      expect(redirectCall.toString()).toContain(
        "error=Authentication%20failed",
      );
    });

    it("should handle profile creation errors gracefully", async () => {
      const mockSession = {
        session: {
          user: {
            id: "profile-error-user",
            email: "profileerror@example.com",
          },
        },
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(null);
      mockUpsertUserProfile.mockRejectedValue(new Error("Database error"));

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=profile-error-code",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/login");
      expect(redirectCall.toString()).toContain(
        "error=Authentication%20failed",
      );
    });
  });

  describe("Edge cases", () => {
    it("should handle user with minimal metadata", async () => {
      const mockSession = {
        session: {
          user: {
            id: "minimal-user",
            email: "minimal@example.com",
            user_metadata: null,
          },
        },
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(null);
      mockUpsertUserProfile.mockResolvedValue({
        id: "minimal-user",
        full_name: "minimal",
        avatar_url: null,
        onboarding_completed: false,
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=minimal-code",
      ) as any;

      const _response = await GET(request);

      expect(mockUpsertUserProfile).toHaveBeenCalledWith({
        id: "minimal-user",
        anonymous_id: null,
        full_name: "minimal",
        avatar_url: null,
        onboarding_completed: false,
      });
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should handle user without email", async () => {
      const mockSession = {
        session: {
          user: {
            id: "no-email-user",
            email: null,
            user_metadata: {
              full_name: "No Email User",
            },
          },
        },
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(null);
      mockUpgradeAnonymousSession.mockResolvedValue({
        success: true,
      });
      mockUpsertUserProfile.mockResolvedValue({
        id: "no-email-user",
        full_name: "No Email User",
        avatar_url: null,
        onboarding_completed: false,
      });

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=no-email-code&anonymousId=anon-no-email",
      ) as any;

      const _response = await GET(request);

      expect(mockUpgradeAnonymousSession).toHaveBeenCalledWith(
        "no-email-user",
        "anon-no-email",
      );
      expect(mockUpsertUserProfile).toHaveBeenCalledWith({
        id: "no-email-user",
        anonymous_id: "anon-no-email",
        full_name: "No Email User",
        avatar_url: null,
        onboarding_completed: false,
      });
      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/dashboard");
      expect(redirectCall.toString()).toContain("auth=success");
    });

    it("should handle URL-encoded redirectTo parameters", async () => {
      const mockSession = {
        session: {
          user: {
            id: "encoded-redirect-user",
            email: "encoded@example.com",
          },
        },
      };

      const mockProfile = {
        id: "encoded-redirect-user",
        full_name: "Encoded User",
      };

      mockExchangeCodeForSession.mockResolvedValue({
        data: mockSession,
        error: null,
      });
      mockGetUserProfile.mockResolvedValue(mockProfile);

      const request = new MockNextRequest(
        "http://localhost:3000/auth/callback?code=encoded-code&redirectTo=%2Fprofile%2Fsettings%3Ftab%3Dsecurity",
      ) as any;

      const _response = await GET(request);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectCall = mockRedirect.mock.calls[0][0];
      expect(redirectCall.toString()).toContain("/profile/settings");
      expect(redirectCall.toString()).toContain("tab=security");
      expect(redirectCall.toString()).toContain("auth=success");
    });
  });
});
