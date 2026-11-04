/**
 * Organization role lookup. The permission check itself is
 * `roleHasPermission` in `@/platform/auth/organization-access`.
 */

import { getUserOrganizationMembership } from '@/platform/server/db/scoped';
import type { OrganizationRole } from './constants';

export type { OrganizationRole };

/**
 * Role for one organization, or null when the user is not a member.
 */
export async function getUserRole(
  userId: string,
  organizationId: string
): Promise<OrganizationRole | null> {
  const membership = await getUserOrganizationMembership(
    userId,
    organizationId
  );
  if (!membership) return null;
  return membership.role;
}
