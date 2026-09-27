import { getGenerationPlanFn } from '@/sequences/generation-plan.fn';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

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
