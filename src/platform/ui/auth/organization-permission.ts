/**
 * Client-side mirror of the server's organization role checks, read off the
 * session's `membership`. Hides what the server would refuse; never a guard.
 */

import { useQuery } from '@tanstack/react-query';
import { roleHasPermission } from '@/platform/auth/organization-access';
import type { getSessionFn } from '@/platform/session.fn';
import { sessionQueryOptions } from './session-query';

type Session = Awaited<ReturnType<typeof getSessionFn>>;
export type OrganizationPermission = Parameters<typeof roleHasPermission>[1];

/** What `requireOrganizationAdminAccess` asks for: admin or owner. */
export const ADMIN_PERMISSION: OrganizationPermission = { member: ['create'] };

export function sessionHasPermission(
  session: Session | undefined,
  permissions: OrganizationPermission
): boolean {
  const role = session?.membership?.role;
  return role ? roleHasPermission(role, permissions) : false;
}

export function useOrganizationPermission(
  permissions: OrganizationPermission
): boolean {
  const { data } = useQuery({
    ...sessionQueryOptions,
    select: (session) => sessionHasPermission(session, permissions),
  });
  return data ?? false;
}
