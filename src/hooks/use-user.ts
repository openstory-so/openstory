"use client";

import { useQuery } from "@tanstack/react-query";
import { getCurrentUser } from "#actions/user";
import type { UserProfile } from "@/types/database";

interface UserData {
  user: UserProfile;
  isAuthenticated: boolean;
  isAnonymous: boolean;
}

async function fetchUser(): Promise<UserData> {
  const result = await getCurrentUser();

  if (!result.success) {
    // Don't throw for auth errors - return a default anonymous user state
    if (result.error?.includes("auth") || result.error?.includes("session")) {
      return {
        user: {} as UserProfile,
        isAuthenticated: false,
        isAnonymous: true,
      };
    }
    throw new Error(result.error || "Failed to fetch user");
  }

  if (!result.data) {
    throw new Error("No user data returned");
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
