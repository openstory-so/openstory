/**
 * Organization access checks for server functions (#813).
 */

import { roleHasPermission } from '@/platform/auth/organization-access';
import type { TeamRole } from './permissions';
import { getUserRole } from './permissions';

async function requirePermission(
  userId: string,
  organizationId: string,
  permissions: Parameters<typeof roleHasPermission>[1],
  denied: string
): Promise<TeamRole> {
  const role = await getUserRole(userId, organizationId);
  if (!role) {
    throw new Error('Access denied: not a member of this organization');
  }
  if (!roleHasPermission(role, permissions)) {
    throw new Error(denied);
  }
  return role;
}

/** Member or above: can create a sequence. */
export async function requireTeamMemberAccess(
  userId: string,
  organizationId: string
): Promise<TeamRole> {
  return requirePermission(
    userId,
    organizationId,
    { sequence: ['create'] },
    'Access denied: member role or higher required'
  );
}

/** Admin or owner: can manage members. */
export async function requireTeamAdminAccess(
  userId: string,
  organizationId: string
): Promise<TeamRole> {
  return requirePermission(
    userId,
    organizationId,
    { member: ['create'] },
    'Access denied: admin role or higher required'
  );
}

/** Owner: can delete the organization. */
export async function requireTeamOwnerAccess(
  userId: string,
  organizationId: string
): Promise<TeamRole> {
  return requirePermission(
    userId,
    organizationId,
    { organization: ['delete'] },
    'Access denied: owner role required'
  );
}
