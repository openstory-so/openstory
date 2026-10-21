import { getGenerationPlanFn } from '@/sequences/generation-plan.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { shotKeys } from '@/shots/ui/use-shots';
import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';

type PlanFlags = { generateStartFrames: boolean; generateVoices: boolean };

export const generationPlanKeys = {
  all: ['generation-plan'] as const,
  bySequence: (sequenceId: string) =>
    [...generationPlanKeys.all, sequenceId] as const,
  detail: (sequenceId: string, flags?: PlanFlags) =>
    [
      ...generationPlanKeys.bySequence(sequenceId),
      flags?.generateStartFrames ?? null,
      flags?.generateVoices ?? null,
    ] as const,
};

/**
 * The generation plan (#1816) — what the footer offers. `flags` asks for the
 * plan with the footer's switches as they are, before they save.
 *
 * Realtime keeps it fresh, but it must not depend on realtime (#1817: one
 * dropped SSE left the footer offering a done stage for minutes): a short
 * stale time, a refetch on focus, and a refused continue invalidates it.
 */
export function useGenerationPlan(sequenceId: string, flags?: PlanFlags) {
  return useQuery({
    queryKey: generationPlanKeys.detail(sequenceId, flags),
    queryFn: () => getGenerationPlanFn({ data: { sequenceId, ...flags } }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    // A switch flip asks for a new plan; keep the last one on screen meanwhile.
    placeholderData: keepPreviousData,
  });
}

/**
 * A refused continue means the footer read old rows. Refetch everything it
 * reads so the NEXT click is right — leaving the cache alone made the same
 * wrong click 25 times in a row (#1822).
 */
export function refetchAfterRefusedContinue(
  queryClient: QueryClient,
  sequenceId: string
): void {
  for (const queryKey of [
    generationPlanKeys.bySequence(sequenceId),
    sequenceKeys.detail(sequenceId),
    sequenceCharacterKeys.list(sequenceId),
    shotKeys.list(sequenceId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
