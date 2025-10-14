/**
 * User action types
 *
 * Import these types directly from this file:
 * @example
 * import type { UserResponse } from "@/app/actions/user/types";
 * // OR
 * import type { UserResponse } from "#actions/user/types";
 */

import type { UserProfile } from "@/types/database";

export interface UserResponse {
  success: boolean;
  data?: {
    user: UserProfile;
    isAuthenticated: boolean;
    isAnonymous: boolean;
  };
  error?: string;
}

export interface TeamResponse {
  success: boolean;
  data?: {
    teamId: string;
    role: string;
    teamName: string;
  };
  error?: string;
}

export interface TeamsResponse {
  success: boolean;
  data?: Array<{
    teamId: string;
    role: string;
    teamName: string;
    joinedAt: string;
  }>;
  error?: string;
}

export interface TeamAccessResponse {
  success: boolean;
  hasAccess: boolean;
  error?: string;
}
