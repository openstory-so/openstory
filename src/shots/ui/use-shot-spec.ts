import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { getShotSpecFn, saveShotSpecFn } from '@/shots/shot-spec.fn';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';
import type { StoredShotSpec } from '@/shots/shot-list.schema';

/**
 * Under the staleness namespace: whatever moves a shot's staleness (a prompt
 * save, a script edit, a rewrite landing) also moves its spec verdict and
 * which prompts are written.
 */
const shotSpecKey = (shotId: string | undefined) =>
  [...shotStalenessNamespace, 'spec', shotId] as const;

export function useShotSpec(args: {
  sequenceId: string;
  shotId: string | undefined;
}) {
  const { sequenceId, shotId } = args;
  return useQuery({
    queryKey: shotSpecKey(shotId),
    queryFn: () => {
      if (!shotId) throw new Error('shotId required');
      return getShotSpecFn({ data: { sequenceId, shotId } });
    },
    enabled: !!shotId,
    staleTime: 30_000,
  });
}

/** The prompts a rebuild wrote: the shot, its staleness and its previews. */
export function invalidateRebuiltPrompts(
  queryClient: QueryClient,
  sequenceId: string,
  shotId: string
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
    queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
    queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
    queryClient.invalidateQueries({
      queryKey: ['shot-prompt-preview', sequenceId],
    }),
  ]);
}

export function useSaveShotSpec(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      shotId: string;
      spec: StoredShotSpec;
      replace: { visual: boolean; motion: boolean };
    }) => saveShotSpecFn({ data: { sequenceId, ...input } }),
    onSuccess: (_result, input) =>
      invalidateRebuiltPrompts(queryClient, sequenceId, input.shotId),
  });
}
