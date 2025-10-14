/**
 * Anonymous User Provider
 * Handles automatic anonymous session creation for new users
 * Maintains Velro's anonymous-first user experience
 */

"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { createAnonymousSessionAction } from "#actions/auth";
import { useUser } from "@/hooks/use-user";

interface AnonymousProviderProps {
  children: React.ReactNode;
}

/**
 * Provider that ensures users always have a session (anonymous or authenticated)
 * Automatically creates anonymous sessions for new visitors
 */
export function AnonymousProvider({ children }: AnonymousProviderProps) {
  const { data: userData, isLoading } = useUser();
  const createAnonymousSession = createAnonymousSessionAction;
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const initializeUser = async () => {
      // If we're still loading, wait
      if (isLoading) {
        return;
      }

      // If user already has a session (authenticated or anonymous), we're done
      if (userData?.user) {
        setIsInitialized(true);
        return;
      }

      // No session exists, create an anonymous one
      try {
        await createAnonymousSession();
        setIsInitialized(true);
      } catch (error) {
        console.error(
          "[AnonymousProvider] Failed to create anonymous session:",
          error,
        );
        // Still set initialized to true to prevent infinite loading
        setIsInitialized(true);
      }
    };

    initializeUser();
  }, [isLoading, userData?.user, createAnonymousSession]);

  // Show loading state while initializing
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Hook to check if user can upgrade from anonymous
 */
export function useAnonymousUpgrade() {
  const { data: userData } = useUser();

  const canUpgrade = userData?.isAnonymous || false;

  return {
    canUpgrade,
  };
}
