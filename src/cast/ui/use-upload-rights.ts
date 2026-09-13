import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { attestUploadsFn, classifyUploadFn } from '@/cast/upload-rights.fn';
import type { PortraitAttestation, UploadRef } from '@/cast/upload-rights';
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

/**
 * One rights check per URL, never refetched while observed. The server is
 * what makes a re-check free (the ledger row); the cache only saves the
 * round trip.
 */
export function uploadRightsQuery(ref: UploadRef) {
  return queryOptions({
    queryKey: uploadRightsKeys.url(ref.url),
    queryFn: () => classifyUploadFn({ data: ref }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
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
