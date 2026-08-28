import { queryOptions, useQuery } from '@tanstack/react-query';
import { getSessionFn } from './server';

export const sessionQueryOptions = queryOptions({
  queryKey: ['session'],
  queryFn: () => getSessionFn(),
  staleTime: 5 * 60 * 1000,
});

/**
 * Session from the React Query cache seeded by `_app` / `_auth` / gift
 * `beforeLoad`. Prefer this over `authClient.useSession()`, which hits
 * `/api/auth/get-session` on every mount and ignores the SSR payload.
 */
export function useAuthSession() {
  return useQuery(sessionQueryOptions);
}
