/**
 * Organization access control shared by the Better Auth plugin (#813).
 * Client-safe: the React client and the server both import these roles.
 */

import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

const statement = {
  ...defaultStatements,
  sequence: ['create', 'update', 'delete'],
  library: ['create', 'update', 'delete'],
  billing: ['update'],
} as const;

export const organizationAc = createAccessControl(statement);

/** Create and update sequences and library items. */
const member = organizationAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ['read'],
  sequence: ['create', 'update'],
  library: ['create', 'update'],
  billing: [],
});

/** Manage members, invitations, and billing. Cannot delete the organization. */
const admin = organizationAc.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
  sequence: ['create', 'update', 'delete'],
  library: ['create', 'update', 'delete'],
  billing: ['update'],
});

/** Admin, plus delete the organization. */
const owner = organizationAc.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
  sequence: ['create', 'update', 'delete'],
  library: ['create', 'update', 'delete'],
  billing: ['update'],
});

export const organizationRoles = {
  owner,
  admin,
  member,
};

const organizationRoleNames = ['owner', 'admin', 'member'] as const;

function isOrganizationRole(
  name: string
): name is (typeof organizationRoleNames)[number] {
  return organizationRoleNames.some((role) => role === name);
}

type OrganizationPermission = Parameters<typeof owner.authorize>[0];

/** Pure role check. Does not read a session, so API keys and OAuth can use it. */
export function roleHasPermission(
  role: string,
  permissions: OrganizationPermission
): boolean {
  for (const name of role.split(',')) {
    if (!isOrganizationRole(name)) continue;
    if (organizationRoles[name].authorize(permissions).success) return true;
  }
  return false;
}
