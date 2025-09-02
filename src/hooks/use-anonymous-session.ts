"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AnonymousUser,
  MockSequence,
} from "@/reducers/anonymous-flow-reducer";

interface AnonymousSessionData {
  user: AnonymousUser;
  sequence?: MockSequence;
  currentStep?: 1 | 2 | 3;
  lastActivity: string;
}

interface UseAnonymousSessionReturn {
  anonymousUser: AnonymousUser | null;
  sessionData: AnonymousSessionData | null;
  isLoading: boolean;
  createSession: () => Promise<void>;
  updateSession: (
    data: Partial<Omit<AnonymousSessionData, "user" | "lastActivity">>,
  ) => Promise<void>;
  clearSession: () => void;
  getStoredSequence: () => MockSequence | null;
  upgradeToMagicLink: (
    email: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

const ANONYMOUS_SESSION_KEY = "velro_anonymous_session";
const SESSION_DURATION_HOURS = 24 * 7; // 7 days

// Generate a unique anonymous user ID
function generateAnonymousUserId(): string {
  return `anon_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// Create a new anonymous user
function createAnonymousUser(): AnonymousUser {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + SESSION_DURATION_HOURS * 60 * 60 * 1000,
  );

  return {
    id: generateAnonymousUserId(),
    sessionId: `session_${Date.now()}`,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

// Check if session is expired
function isSessionExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date();
}

// Load session data from localStorage
function loadSessionData(): AnonymousSessionData | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = localStorage.getItem(ANONYMOUS_SESSION_KEY);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as AnonymousSessionData;

    // Check if session is expired
    if (isSessionExpired(parsed.user.expiresAt)) {
      localStorage.removeItem(ANONYMOUS_SESSION_KEY);
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn("Failed to load anonymous session:", error);
    localStorage.removeItem(ANONYMOUS_SESSION_KEY);
    return null;
  }
}

// Save session data to localStorage
function saveSessionData(data: AnonymousSessionData): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(ANONYMOUS_SESSION_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn("Failed to save anonymous session:", error);
  }
}

export function useAnonymousSession(): UseAnonymousSessionReturn {
  const [sessionData, setSessionData] = useState<AnonymousSessionData | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);

  // Initialize session on mount
  useEffect(() => {
    const existingSession = loadSessionData();
    setSessionData(existingSession);
    setIsLoading(false);
  }, []);

  // Create a new anonymous session
  const createSession = useCallback(async (): Promise<void> => {
    const user = createAnonymousUser();
    const newSessionData: AnonymousSessionData = {
      user,
      lastActivity: new Date().toISOString(),
    };

    setSessionData(newSessionData);

    try {
      saveSessionData(newSessionData);
    } catch (error) {
      console.error("Failed to create anonymous session:", error);
      // Still set the session data in memory even if localStorage fails
    }
  }, []);

  // Update session data
  const updateSession = useCallback(
    async (
      data: Partial<Omit<AnonymousSessionData, "user" | "lastActivity">>,
    ): Promise<void> => {
      if (!sessionData) return;

      const updatedSessionData: AnonymousSessionData = {
        ...sessionData,
        ...data,
        lastActivity: new Date().toISOString(),
      };

      setSessionData(updatedSessionData);

      try {
        saveSessionData(updatedSessionData);
      } catch (error) {
        console.error("Failed to update anonymous session:", error);
        // Still update in memory even if localStorage fails
      }
    },
    [sessionData],
  );

  // Clear session
  const clearSession = useCallback((): void => {
    if (typeof window === "undefined") return;

    localStorage.removeItem(ANONYMOUS_SESSION_KEY);
    setSessionData(null);
  }, []);

  // Get stored sequence
  const getStoredSequence = useCallback((): MockSequence | null => {
    return sessionData?.sequence || null;
  }, [sessionData]);

  // Upgrade anonymous session to magic link account
  const upgradeToMagicLink = useCallback(
    async (email: string): Promise<{ success: boolean; error?: string }> => {
      if (!sessionData) {
        return { success: false, error: "No anonymous session found" };
      }

      try {
        // In a real implementation, this would call an API endpoint
        // For now, we'll simulate the upgrade process
        console.log(
          `Upgrading anonymous user ${sessionData.user.id} to ${email}`,
        );

        // Simulate API delay
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // In the real implementation, this would:
        // 1. Send magic link to email
        // 2. Create pending user account linked to anonymous session
        // 3. Transfer anonymous data on magic link verification

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to upgrade account",
        };
      }
    },
    [sessionData],
  );

  return {
    anonymousUser: sessionData?.user || null,
    sessionData,
    isLoading,
    createSession,
    updateSession,
    clearSession,
    getStoredSequence,
    upgradeToMagicLink,
  };
}

// Hook for checking if user should see upgrade prompts
export function useUpgradePrompts(sessionData: AnonymousSessionData | null) {
  const shouldShowUpgradePrompt = useCallback(
    (
      trigger: "frames_generated" | "motion_generated" | "time_spent",
    ): boolean => {
      if (!sessionData) return false;

      const sessionAge =
        Date.now() - new Date(sessionData.user.createdAt).getTime();
      const minutesActive = sessionAge / (1000 * 60);

      switch (trigger) {
        case "frames_generated":
          // Show prompt after user generates their first storyboard
          return (sessionData.sequence?.frames?.length || 0) > 0;

        case "motion_generated":
          // Show prompt after user generates motion for any frame
          return (
            sessionData.sequence?.frames?.some((frame) => frame.video_url) ||
            false
          );

        case "time_spent":
          // Show prompt after 10 minutes of activity
          return minutesActive > 10;

        default:
          return false;
      }
    },
    [sessionData],
  );

  return {
    shouldShowUpgradePrompt,
  };
}

// Hook for tracking anonymous user analytics
export function useAnonymousAnalytics(
  sessionData: AnonymousSessionData | null,
) {
  const trackEvent = useCallback(
    (event: string, properties?: Record<string, unknown>) => {
      if (!sessionData) return;

      // In a real implementation, this would send analytics events
      console.log(`Anonymous analytics: ${event}`, {
        anonymousUserId: sessionData.user.id,
        sessionId: sessionData.user.sessionId,
        ...properties,
      });
    },
    [sessionData],
  );

  const trackStepCompletion = useCallback(
    (step: 1 | 2 | 3) => {
      trackEvent("step_completed", { step });
    },
    [trackEvent],
  );

  const trackSequenceCreated = useCallback(
    (sequenceId: string) => {
      trackEvent("sequence_created", { sequenceId });
    },
    [trackEvent],
  );

  const trackFramesGenerated = useCallback(
    (count: number) => {
      trackEvent("frames_generated", { count });
    },
    [trackEvent],
  );

  const trackMotionGenerated = useCallback(
    (frameId: string) => {
      trackEvent("motion_generated", { frameId });
    },
    [trackEvent],
  );

  const trackUpgradePromptShown = useCallback(
    (trigger: string) => {
      trackEvent("upgrade_prompt_shown", { trigger });
    },
    [trackEvent],
  );

  const trackUpgradeAttempted = useCallback(
    (email: string) => {
      trackEvent("upgrade_attempted", { email });
    },
    [trackEvent],
  );

  return {
    trackEvent,
    trackStepCompletion,
    trackSequenceCreated,
    trackFramesGenerated,
    trackMotionGenerated,
    trackUpgradePromptShown,
    trackUpgradeAttempted,
  };
}
