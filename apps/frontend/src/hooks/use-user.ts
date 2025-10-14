"use client";

import { useQuery } from "@tanstack/react-query";
import { getCurrentUser, getUserTeam } from "#actions/user";
import { authClient } from "@/lib/auth/client";
import type { UserProfile } from "@/types/database";

interface UserData {
  user: UserProfile;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  teamId?: string;
  teamRole?: string;
  teamName?: string;
}

async function fetchUser(): Promise<UserData> {
  // Call the server action to get or create user
  const result = await getCurrentUser();

  if (!result.success) {
    // Handle case where server needs client to create session first
    if (result.error === "REQUIRES_CLIENT_AUTH") {
      // Create anonymous session with BetterAuth
      const { data, error } = await authClient.signIn.anonymous();

      if (!error && data) {
        // Retry the server action with the new session
        const retryResult = await getCurrentUser();
        if (retryResult.success && retryResult.data) {
          // Fetch team info for authenticated users
          const teamResult = await getUserTeam();
          return {
            ...retryResult.data,
            teamId: teamResult.data?.teamId,
            teamRole: teamResult.data?.role,
            teamName: teamResult.data?.teamName,
          };
        }
      }

      // If we still can't authenticate, throw error
      throw new Error(error?.message || "Failed to create anonymous session");
    }

    throw new Error(result.error || "Failed to fetch user");
  }

  if (!result.data) {
    throw new Error("No user data returned");
  }

  // Fetch team info for authenticated users
  const teamResult = await getUserTeam();

  return {
    ...result.data,
    teamId: teamResult.data?.teamId,
    teamRole: teamResult.data?.role,
    teamName: teamResult.data?.teamName,
  };
}

/**
 * Simple hook for client components that need user data
 * Automatically handles both authenticated and anonymous users with BetterAuth
 * Handles auth errors by creating new anonymous sessions
 */
export function useUser() {
  return useQuery({
    queryKey: ["user"],
    queryFn: fetchUser,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: (failureCount, error) => {
      // Retry once for auth errors
      if (
        error instanceof Error &&
        (error.message.includes("authentication") ||
          error.message.includes("REQUIRES_CLIENT_AUTH"))
      ) {
        return failureCount < 1;
      }
      return failureCount < 1;
    },
    refetchOnWindowFocus: false, // Prevent refetch on focus to avoid session conflicts
  });
}
