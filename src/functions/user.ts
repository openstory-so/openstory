/**
 * User Server Functions
 * End-to-end type-safe functions for user-related operations
 */

import { createServerFn } from '@tanstack/react-start';

import { authMiddleware } from './middleware';
import { ensureUserAndTeam, resolveUserTeam } from '@/lib/db/scoped';
import type { User } from '@/lib/db/schema';

// ============================================================================
// Get Current User
// ============================================================================

export type CurrentUserData = {
  user: User;
  isAuthenticated: boolean;
  teamId?: string;
  teamRole?: string;
  teamName?: string;
};

/**
 * Get the current authenticated user with team information
 * Ensures user and team exist in the database
 * @returns Current user profile with team data
 */
export const getCurrentUserProfileFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<CurrentUserData> => {
    // Ensure user and team exist
    const ensureResult = await ensureUserAndTeam(context.user);

    if (!ensureResult.success || !ensureResult.data) {
      throw new Error(ensureResult.error || 'Failed to ensure user and team');
    }

    // Get complete team info with team name
    const teamMembership = await resolveUserTeam(context.user.id);

    return {
      user: ensureResult.data,
      isAuthenticated: true,
      teamId: teamMembership?.teamId,
      teamRole: teamMembership?.role,
      teamName: teamMembership?.teamName,
    };
  });
