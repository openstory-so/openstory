/**
 * Route guards for account-bound pages.
 *
 * The app shell is open to anonymous visitors (see `_app/route.tsx`), but
 * pages that only make sense for a signed-in user with their own data — saved
 * sequences, settings, credits, admin — redirect to /login. Use in a route's
 * `beforeLoad`:
 *
 *   beforeLoad: async ({ context: { queryClient }, location }) => {
 *     await requireSessionOrRedirect(queryClient, location.href);
 *   },
 */

import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { sessionQueryOptions } from './session-query';

export async function requireSessionOrRedirect(
  queryClient: QueryClient,
  redirectTo: string
) {
  // A *failed* session lookup throws out of ensureQueryData (getSessionFn
  // rejects on error) and propagates to the route's errorComponent — only a
  // settled null session redirects to /login.
  const session = await queryClient.ensureQueryData(sessionQueryOptions);
  if (!session) {
    throw redirect({ to: '/login', search: { redirectTo } });
  }
  return session;
}
