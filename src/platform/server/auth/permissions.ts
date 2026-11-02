/**
 * Organization role lookup. The permission check itself is
 * `roleHasPermission` in `@/platform/auth/organization-access`.
 */

import { getUserTeamMembership } from '@/platform/server/db/scoped';
import type { TeamRole } from './constants';

export type { TeamRole };

/**
 * Role for one organization, or null when the user is not a member.
 */
export async function getUserRole(
  userId: string,
  organizationId: string
): Promise<TeamRole | null> {
  const membership = await getUserTeamMembership(userId, organizationId);
  if (!membership) return null;
  return membership.role;
}
