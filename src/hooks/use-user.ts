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
    throw new Error(result.error || "Failed to fetch user");
  }

  return result.data;
}

/**
 * Simple hook for client components that need user data
 * Automatically handles both authenticated and anonymous users
 */
export function useUser() {
  return useQuery({
    queryKey: ["user"],
    queryFn: fetchUser,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });
}
