import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import {
  attestUploadsFn,
  classifyUploadFn,
  retryUploadCheckFn,
} from '@/cast/upload-rights.fn';
import type {
  PortraitAttestation,
  UploadRef,
  UploadRights,
} from '@/cast/upload-rights';
import {
  queryOptions,
  useMutation,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';

export const uploadRightsKeys = {
  all: ['upload-rights'] as const,
  url: (url: string) => [...uploadRightsKeys.all, url] as const,
};

/** How often to ask again while the check's run is going. */
const CHECK_POLL_MS = 1500;
/** Past this the run is stuck (queued or paused): show it as a failure. */
const CHECK_GIVE_UP_MS = 3 * 60_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/**
 * The check's answer for one URL, never refetched while observed. The upload
 * started the check on the server (#2192); this only waits for its verdict,
 * so leaving the page does not stop it. A failed check is the query's error.
 */
export function uploadRightsQuery(ref: UploadRef) {
  return queryOptions({
    queryKey: uploadRightsKeys.url(ref.url),
    queryFn: async ({ signal }): Promise<UploadRights> => {
      const giveUpAt = Date.now() + CHECK_GIVE_UP_MS;
      for (;;) {
        const check = await classifyUploadFn({ data: ref, signal });
        if (check.status !== 'checking') return check;
        if (Date.now() >= giveUpAt) {
          throw new Error(
            'The check for a real person is taking too long. Try again.'
          );
        }
        await wait(CHECK_POLL_MS, signal);
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Start a failed check again, then wait for its answer. */
export function useRetryUploadCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ref: UploadRef) => retryUploadCheckFn({ data: ref }),
    onSuccess: (_check, ref) =>
      queryClient.refetchQueries({ queryKey: uploadRightsKeys.url(ref.url) }),
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

/** Rights per `refs` entry, in order. Idle (not pending) while logged out. */
export function useUploadRights(refs: UploadRef[]) {
  const { isAuthenticated } = useAuthGate();
  return useQueries({
    queries: refs.map((ref) => ({
      ...uploadRightsQuery(ref),
      enabled: isAuthenticated,
    })),
  });
}

/** Record the sign-off; every rights check for those URLs then re-reads. */
export function useAttestUploads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (attestations: PortraitAttestation[]) =>
      attestUploadsFn({ data: { attestations } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: uploadRightsKeys.all }),
    onError: (error) => {
      toast.error(error.message);
    },
  });
}
