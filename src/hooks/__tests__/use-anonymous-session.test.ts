import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockSequence } from "@/reducers/anonymous-flow-reducer";
import {
  useAnonymousAnalytics,
  useAnonymousSession,
  useUpgradePrompts,
} from "../use-anonymous-session";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

describe("useAnonymousSession", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Session Initialization", () => {
    it("should start with no session", () => {
      const { result } = renderHook(() => useAnonymousSession());
      expect(result.current.anonymousUser).toBeNull();
      expect(result.current.sessionData).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("should load existing valid session from localStorage", async () => {
      const existingSession = {
        user: {
          id: "anon_123",
          sessionId: "session_123",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 1 day from now
        },
        lastActivity: new Date().toISOString(),
      };

      localStorageMock.setItem(
        "velro_anonymous_session",
        JSON.stringify(existingSession),
      );

      const { result } = renderHook(() => useAnonymousSession());

      await waitFor(() => {
        expect(result.current.sessionData).toEqual(existingSession);
        expect(result.current.anonymousUser).toEqual(existingSession.user);
      });
    });

    it("should clear expired session from localStorage", async () => {
      const expiredSession = {
        user: {
          id: "anon_expired",
          sessionId: "session_expired",
          createdAt: new Date(
            Date.now() - 8 * 24 * 60 * 60 * 1000,
          ).toISOString(), // 8 days ago
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
        },
        lastActivity: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      };

      localStorageMock.setItem(
        "velro_anonymous_session",
        JSON.stringify(expiredSession),
      );

      const { result } = renderHook(() => useAnonymousSession());

      await waitFor(() => {
        expect(result.current.sessionData).toBeNull();
        expect(result.current.anonymousUser).toBeNull();
        expect(localStorageMock.removeItem).toHaveBeenCalledWith(
          "velro_anonymous_session",
        );
      });
    });

    it("should handle corrupted localStorage data", async () => {
      localStorageMock.setItem("velro_anonymous_session", "invalid json");

      const { result } = renderHook(() => useAnonymousSession());

      await waitFor(() => {
        expect(result.current.sessionData).toBeNull();
        expect(console.warn).toHaveBeenCalledWith(
          "Failed to load anonymous session:",
          expect.any(Error),
        );
        expect(localStorageMock.removeItem).toHaveBeenCalledWith(
          "velro_anonymous_session",
        );
      });
    });
  });

  describe("Session Creation", () => {
    it("should create new anonymous session", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      expect(result.current.anonymousUser).toBeDefined();
      expect(result.current.anonymousUser?.id).toMatch(/^anon_\d+_[a-z0-9]+$/);
      expect(result.current.anonymousUser?.sessionId).toMatch(/^session_\d+$/);
      expect(result.current.sessionData?.lastActivity).toBeDefined();

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "velro_anonymous_session",
        expect.stringContaining("anon_"),
      );
    });

    it("should create session with 7-day expiry", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      const expiresAt = new Date(result.current.anonymousUser?.expiresAt || "");
      const createdAt = new Date(result.current.anonymousUser?.createdAt || "");
      const diffInDays =
        (expiresAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

      expect(diffInDays).toBeCloseTo(7, 0);
    });

    it("should handle session creation errors gracefully", async () => {
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error("Storage quota exceeded");
      });

      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await expect(result.current.createSession()).rejects.toThrow(
          "Storage quota exceeded",
        );
      });

      expect(console.error).toHaveBeenCalledWith(
        "Failed to create anonymous session:",
        expect.any(Error),
      );
    });
  });

  describe("Session Updates", () => {
    it("should update session data", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      const mockSequence: MockSequence = {
        id: "seq_123",
        name: "Test Sequence",
        script: "Test script",
        styleId: "style_123",
        frames: [],
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await act(async () => {
        await result.current.updateSession({
          sequence: mockSequence,
          currentStep: 2,
        });
      });

      expect(result.current.sessionData?.sequence).toEqual(mockSequence);
      expect(result.current.sessionData?.currentStep).toBe(2);
      expect(
        new Date(result.current.sessionData?.lastActivity || "").getTime(),
      ).toBeGreaterThan(
        new Date(result.current.anonymousUser?.createdAt || "").getTime(),
      );
    });

    it("should not update session if no session exists", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.updateSession({ currentStep: 2 });
      });

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it("should handle update errors gracefully", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      localStorageMock.setItem.mockImplementation(() => {
        throw new Error("Storage error");
      });

      await act(async () => {
        await expect(
          result.current.updateSession({ currentStep: 2 }),
        ).rejects.toThrow("Storage error");
      });

      expect(console.error).toHaveBeenCalledWith(
        "Failed to update anonymous session:",
        expect.any(Error),
      );
    });
  });

  describe("Session Clearing", () => {
    it("should clear session and localStorage", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      expect(result.current.anonymousUser).toBeDefined();

      act(() => {
        result.current.clearSession();
      });

      expect(result.current.anonymousUser).toBeNull();
      expect(result.current.sessionData).toBeNull();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "velro_anonymous_session",
      );
    });
  });

  describe("getStoredSequence", () => {
    it("should return stored sequence", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      const mockSequence: MockSequence = {
        id: "seq_123",
        name: "Test",
        script: "Script",
        styleId: "style_123",
        frames: [],
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await act(async () => {
        await result.current.createSession();
      });

      await act(async () => {
        await result.current.updateSession({ sequence: mockSequence });
      });

      // Wait for state to update
      await new Promise((resolve) => setTimeout(resolve, 10));

      const storedSequence = result.current.getStoredSequence();
      expect(storedSequence).toEqual(mockSequence);
    });

    it("should return null if no sequence stored", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      const storedSequence = result.current.getStoredSequence();
      expect(storedSequence).toBeNull();
    });
  });

  describe("upgradeToMagicLink", () => {
    it("should simulate magic link upgrade", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      await act(async () => {
        await result.current.createSession();
      });

      const upgradeResult =
        await result.current.upgradeToMagicLink("test@example.com");

      expect(upgradeResult.success).toBe(true);
      expect(upgradeResult.error).toBeUndefined();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Upgrading anonymous user"),
      );
    });

    it("should fail upgrade without session", async () => {
      const { result } = renderHook(() => useAnonymousSession());

      const upgradeResult =
        await result.current.upgradeToMagicLink("test@example.com");

      expect(upgradeResult.success).toBe(false);
      expect(upgradeResult.error).toBe("No anonymous session found");
    });
  });
});

describe("useUpgradePrompts", () => {
  describe("shouldShowUpgradePrompt", () => {
    it("should show prompt after frames generated", () => {
      const sessionData = {
        user: {
          id: "anon_123",
          sessionId: "session_123",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Script",
          styleId: "style_123",
          frames: [
            {
              id: "frame_1",
              sequence_id: "seq_123",
              order_index: 1,
              description: "Frame",
              thumbnail_url: "url",
              video_url: null,
              duration_ms: 5000,
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          status: "completed" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        lastActivity: new Date().toISOString(),
      };

      const { result } = renderHook(() => useUpgradePrompts(sessionData));

      expect(result.current.shouldShowUpgradePrompt("frames_generated")).toBe(
        true,
      );
      expect(result.current.shouldShowUpgradePrompt("motion_generated")).toBe(
        false,
      );
    });

    it("should show prompt after motion generated", () => {
      const sessionData = {
        user: {
          id: "anon_123",
          sessionId: "session_123",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        sequence: {
          id: "seq_123",
          name: "Test",
          script: "Script",
          styleId: "style_123",
          frames: [
            {
              id: "frame_1",
              sequence_id: "seq_123",
              order_index: 1,
              description: "Frame",
              thumbnail_url: "url",
              video_url: "video.mp4",
              duration_ms: 5000,
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          status: "completed" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        lastActivity: new Date().toISOString(),
      };

      const { result } = renderHook(() => useUpgradePrompts(sessionData));

      expect(result.current.shouldShowUpgradePrompt("motion_generated")).toBe(
        true,
      );
    });

    it("should show prompt after 10 minutes of activity", () => {
      const sessionData = {
        user: {
          id: "anon_123",
          sessionId: "session_123",
          createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // 11 minutes ago
          expiresAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        lastActivity: new Date().toISOString(),
      };

      const { result } = renderHook(() => useUpgradePrompts(sessionData));

      expect(result.current.shouldShowUpgradePrompt("time_spent")).toBe(true);
    });

    it("should not show prompt before 10 minutes", () => {
      const sessionData = {
        user: {
          id: "anon_123",
          sessionId: "session_123",
          createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
          expiresAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        lastActivity: new Date().toISOString(),
      };

      const { result } = renderHook(() => useUpgradePrompts(sessionData));

      expect(result.current.shouldShowUpgradePrompt("time_spent")).toBe(false);
    });

    it("should return false if no session data", () => {
      const { result } = renderHook(() => useUpgradePrompts(null));

      expect(result.current.shouldShowUpgradePrompt("frames_generated")).toBe(
        false,
      );
      expect(result.current.shouldShowUpgradePrompt("motion_generated")).toBe(
        false,
      );
      expect(result.current.shouldShowUpgradePrompt("time_spent")).toBe(false);
    });
  });
});

describe("useAnonymousAnalytics", () => {
  const mockSessionData = {
    user: {
      id: "anon_123",
      sessionId: "session_123",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    lastActivity: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("should track events with session data", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackEvent("test_event", { foo: "bar" });

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: test_event",
      {
        anonymousUserId: "anon_123",
        sessionId: "session_123",
        foo: "bar",
      },
    );
  });

  it("should not track events without session data", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(null));

    result.current.trackEvent("test_event");

    expect(console.log).not.toHaveBeenCalled();
  });

  it("should track step completion", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackStepCompletion(2);

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: step_completed",
      expect.objectContaining({ step: 2 }),
    );
  });

  it("should track sequence creation", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackSequenceCreated("seq_456");

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: sequence_created",
      expect.objectContaining({ sequenceId: "seq_456" }),
    );
  });

  it("should track frames generated", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackFramesGenerated(5);

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: frames_generated",
      expect.objectContaining({ count: 5 }),
    );
  });

  it("should track motion generated", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackMotionGenerated("frame_123");

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: motion_generated",
      expect.objectContaining({ frameId: "frame_123" }),
    );
  });

  it("should track upgrade prompt shown", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackUpgradePromptShown("frames_generated");

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: upgrade_prompt_shown",
      expect.objectContaining({ trigger: "frames_generated" }),
    );
  });

  it("should track upgrade attempted", () => {
    const { result } = renderHook(() => useAnonymousAnalytics(mockSessionData));

    result.current.trackUpgradeAttempted("test@example.com");

    expect(console.log).toHaveBeenCalledWith(
      "Anonymous analytics: upgrade_attempted",
      expect.objectContaining({ email: "test@example.com" }),
    );
  });
});
