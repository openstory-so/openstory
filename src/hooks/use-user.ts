"use client";

import { useQuery } from "@tanstack/react-query";
import type { UserProfile } from "@/types/database";

interface UserData {
  user: UserProfile;
  isAuthenticated: boolean;
  isAnonymous: boolean;
}

async function fetchUser(): Promise<UserData> {
  const response = await fetch("/api/v1/user");
  const result = await response.json();

  if (!result.success) {
    // Don't throw for auth errors - the API will handle creating a new session
    if (response.status === 401 || response.status === 403) {
      // Return a default anonymous user state
      return {
        user: {} as UserProfile,
        isAuthenticated: false,
        isAnonymous: true,
      };
    }
    throw new Error(result.error || "Failed to fetch user");
  }

  return result.data;
}

/**
 * Simple hook for client components that need user data
 * Automatically handles both authenticated and anonymous users
 * Handles refresh token errors by creating new anonymous sessions
 */
export function useUser() {
  return useQuery({
    queryKey: ["user"],
    queryFn: fetchUser,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: (failureCount, error) => {
      // Retry once for auth errors
      if (error instanceof Error && error.message.includes("refresh_token")) {
        return failureCount < 1;
      }
      return failureCount < 1;
    },
    refetchOnWindowFocus: false, // Prevent refetch on focus to avoid refresh token errors
  });
}
