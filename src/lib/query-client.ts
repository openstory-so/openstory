import { openBillingGate } from '@/hooks/use-billing-gate-dialog';
import { isAuthError, isInsufficientCreditsError } from '@/lib/errors';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'query-client', 'query-client']);

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** Set when the mutation surfaces its own error UI — suppresses the global toast. */
      inlineError?: boolean;
    };
  }
}

const MAX_QUERY_RETRIES = typeof window === 'undefined' ? 0 : 3;

export function makeQueryClient() {
  let qc!: QueryClient;
  qc = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        void qc.invalidateQueries({
          queryKey: mutation.options.mutationKey,
        });
      },
      onError: (error, _variables, _context, mutation) => {
        logger.error('[MUTATION ERROR]', {
          data: error instanceof Error ? error.message : error,
        });
        // Out of credits is a billing problem, not an error toast — open the
        // globally-mounted gate dialog instead (#1099).
        if (isInsufficientCreditsError(error)) {
          openBillingGate('insufficient');
          return;
        }
        // Mutations that render their own inline error opt out, so a failure
        // isn't reported twice.
        if (mutation.meta?.inlineError) return;
        toast.error(error.message);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 2 * 60 * 1000,
        // RQ's own default is 3 retries in the browser, 0 on the server; keep
        // that, but never retry a 401/403 — the session won't appear between
        // attempts, and each attempt is another error-level log line (#1333).
        retry: (failureCount, error) =>
          !isAuthError(error) && failureCount < MAX_QUERY_RETRIES,
      },
    },
  });
  return qc;
}

let browserQueryClient: QueryClient | undefined;

/**
 * Returns a QueryClient singleton on the client, fresh instance on the server.
 * Shared between TanStack Router context and Better Auth hooks.
 */
export function getQueryClient() {
  if (typeof window === 'undefined') {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}
