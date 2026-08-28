/**
 * Auth-aware query for data that has both a public (anonymous) and a
 * team-scoped (authenticated) variant — talent, styles, library locations.
 *
 * Only a *settled* null session counts as anonymous: while the session is
 * loading the query waits, and a failed session lookup surfaces as a query
 * error instead of silently serving the public variant to a signed-in user.
 * The two variants use distinct query keys so an auth-state transition never
 * serves the other audience's cached payload.
 */

import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useAuthSession } from '@/lib/auth/session-query';

export function usePublicOrTeamQuery<T>(options: {
  teamKey: QueryKey;
  publicKey: QueryKey;
  teamFn: () => Promise<T>;
  publicFn: () => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
}) {
  const { data: session, isPending, error: sessionError } = useAuthSession();
  const isAuthenticated = !!session;

  return useQuery<T>({
    queryKey: isAuthenticated ? options.teamKey : options.publicKey,
    queryFn: () => {
      if (sessionError) {
        throw new Error(`Failed to fetch session: ${sessionError.message}`, {
          cause: sessionError,
        });
      }
      return isAuthenticated ? options.teamFn() : options.publicFn();
    },
    staleTime: options.staleTime,
    enabled: (options.enabled ?? true) && !isPending,
  });
}
