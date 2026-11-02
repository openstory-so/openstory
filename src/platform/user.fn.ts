/**
 * User Server Functions
 * End-to-end type-safe functions for user-related operations
 */

import { createServerFn } from '@tanstack/react-start';

import { authMiddleware } from './middleware.fn';
import {
  ensureUserAndTeam,
  resolveUserTeam,
} from '@/platform/server/db/scoped';
import type { User } from '@/platform/server/db/schema';

// ============================================================================
// Get Current User
// ============================================================================

export type CurrentUserData = {
  user: User;
  isAuthenticated: boolean;
  organizationId?: string;
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
    const teamMembership = await resolveUserTeam(
      context.user.id,
      context.session.session.activeOrganizationId
    );

    return {
      user: ensureResult.data,
      isAuthenticated: true,
      organizationId: teamMembership?.organizationId,
      teamRole: teamMembership?.role,
      teamName: teamMembership?.teamName,
    };
  });
