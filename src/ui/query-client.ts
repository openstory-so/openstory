import { notifyInsufficientCredits } from '@/billing/ui/notify-insufficient-credits';
import { isAuthError, isInsufficientCreditsError } from '@/platform/errors';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'query-client', 'query-client']);

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /**
       * Opt in to the global error toast (#1571). Off by default: nearly every
       * mutation surfaces its own failure (titled toast, inline state,
       * try/catch), and the bare toast on top was a duplicate. Set it on a
       * hook whose callers do nothing with the error.
       */
      globalError?: boolean;
    };
  }
}

const MAX_QUERY_RETRIES = typeof window === 'undefined' ? 0 : 3;

export function makeQueryClient() {
  let qc!: QueryClient;
  const clearRejectedSession = (error: unknown) => {
    // A 403 is a permission failure, not a rejected session. Check structurally
    // because server-fn errors are reconstructed across the RPC boundary.
    if (
      typeof error !== 'object' ||
      error === null ||
      !('statusCode' in error) ||
      error.statusCode !== 401
    )
      return;

    // Cancelling first prevents an older session read from putting the rejected
    // session back. Publish null immediately so session-gated reads stop; merely
    // invalidating would leave truthy data available while the refetch runs.
    void qc.cancelQueries({ queryKey: ['session'], exact: true });
    qc.setQueryData(['session'], null);
  };
  qc = new QueryClient({
    queryCache: new QueryCache({ onError: clearRejectedSession }),
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        void qc.invalidateQueries({
          queryKey: mutation.options.mutationKey,
        });
      },
      onError: (error, _variables, _context, mutation) => {
        clearRejectedSession(error);
        logger.error('[MUTATION ERROR]', {
          data: error instanceof Error ? error.message : error,
        });
        // Out of credits is a billing problem, not an error toast — the
        // low-balance toast carries the top-up offer; "Other options" opens
        // the gate.
        if (isInsufficientCreditsError(error)) {
          notifyInsufficientCredits();
          return;
        }
        // Opt-in: a mutation that handles its own error would otherwise
        // report it twice.
        if (!mutation.meta?.globalError) return;
        toast.error(error.message);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 2 * 60 * 1000,
        // RQ's own default is 3 retries in the browser, 0 on the server; keep
        // that, but never retry a 401/403 — the session won't appear between
        // attempts, and each attempt repeats the rejection (#1333).
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
