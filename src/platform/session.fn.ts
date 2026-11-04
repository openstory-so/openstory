/**
 * Session read for TanStack Start.
 *
 * Server-only `createServerFn` — Better Auth + Start's recommended pattern.
 * Call from `beforeLoad` / React Query; the handler runs in-process on SSR
 * and as an RPC on the client. Do not use `authClient.useSession()` for
 * "am I logged in" — that is a second store that refetches on mount.
 *
 * `membership` is the user's role in the active organization, so the UI can
 * hide what the server would refuse (`useOrganizationPermission`).
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { getAuth } from '@/platform/server/auth/config';
import { getUserOrganizationMembership } from '@/platform/server/db/scoped';

export const getSessionFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const sessionData = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    if (!sessionData) return null;
    const organizationId = sessionData.session.activeOrganizationId;
    const membership = organizationId
      ? await getUserOrganizationMembership(sessionData.user.id, organizationId)
      : null;
    return { ...sessionData, membership };
  }
);
