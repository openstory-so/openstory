import {
  recommendStylesForScriptFn,
  type StyleRecommendation,
} from '@/functions/ai';
import {
  getPublicStylesFn,
  getSequenceStyleFn,
  getStyleFn,
  getStylesFn,
  promoteSequenceStyleFn,
} from '@/functions/styles';
import { usePublicOrTeamQuery } from '@/hooks/use-public-or-team-query';
import { useAuthSession } from '@/lib/auth/session-query';
import { publicStylesQueryKey } from '@/lib/style/public-styles-query';
import { simpleHash } from '@/lib/utils/hash';
import type { Style } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Query keys
export const styleKeys = {
  all: ['styles'] as const,
  lists: () => [...styleKeys.all, 'list'] as const,
  list: (teamId?: string) => [...styleKeys.lists(), teamId] as const,
  public: () => publicStylesQueryKey,
  details: () => [...styleKeys.all, 'detail'] as const,
  detail: (id: string) => [...styleKeys.details(), id] as const,
  forSequence: (sequenceId: string) =>
    [...styleKeys.all, 'sequence', sequenceId] as const,
  // Recommendations are keyed by a hash of the (trimmed) script, so the same
  // script never re-spends an LLM call and enhancing — which changes the
  // script — naturally lands on a fresh key.
  recommend: (scriptHash: string, limit: number) =>
    [...styleKeys.all, 'recommend', scriptHash, limit] as const,
};

// Hook for listing styles.
// Anonymous (logged-out) visitors get the public style catalogue so they can
// compose a sequence before signing in; authenticated users get their team's
// styles plus public ones (see usePublicOrTeamQuery for the session rules).
export function useStyles(teamId?: string, enabled = true) {
  return usePublicOrTeamQuery<Style[]>({
    teamKey: styleKeys.list(teamId),
    publicKey: styleKeys.public(),
    teamFn: () => getStylesFn(),
    publicFn: () => getPublicStylesFn(),
    staleTime: 10 * 60 * 1000, // 10 minutes (styles change less frequently)
    enabled,
  });
}

// Hook for getting single style. `null` when the id resolves to nothing the
// team can see (see getStyleFn) — callers render as if there were no style.
export function useStyle(id: string) {
  return useQuery<Style | null>({
    queryKey: styleKeys.detail(id),
    queryFn: async () => {
      return getStyleFn({ data: { styleId: id } });
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!id,
  });
}

/**
 * The style a sequence was generated with, resolved in the sequence's team
 * scope (see getSequenceStyleFn). Prefer this over `useStyle(sequence.styleId)`
 * whenever a sequence is in hand — it also works for admins viewing another
 * team's sequence. `null` when the row is gone.
 */
export function useSequenceStyle(sequenceId: string) {
  return useQuery<Style | null>({
    queryKey: styleKeys.forSequence(sequenceId),
    queryFn: () => getSequenceStyleFn({ data: { sequenceId } }),
    staleTime: 10 * 60 * 1000,
    enabled: !!sequenceId,
  });
}

export type { StyleRecommendation };

const MIN_RECOMMEND_SCRIPT_LENGTH = 3;

/**
 * Rank the team's + public styles against the current script/one-liner.
 *
 * Auth-gated (the underlying server fn is billed, like Enhance) and
 * caller-gated via `enabled` so the LLM call is only spent on an explicit
 * trigger (the Recommend button — never automatically, #1279). Repeats
 * are free: the cache key is the script hash and `staleTime: Infinity` means a
 * given script is only ranked once.
 */
export function useRecommendedStyles(
  script: string | null | undefined,
  options?: { enabled?: boolean; limit?: number }
) {
  const { data: session } = useAuthSession();
  const isAuthenticated = !!session;

  const trimmed = (script ?? '').trim();
  const limit = options?.limit ?? 5;
  const scriptHash = simpleHash(trimmed);

  return useQuery({
    queryKey: styleKeys.recommend(scriptHash, limit),
    queryFn: () =>
      recommendStylesForScriptFn({ data: { script: trimmed, limit } }),
    enabled:
      (options?.enabled ?? true) &&
      isAuthenticated &&
      trimmed.length >= MIN_RECOMMEND_SCRIPT_LENGTH,
    staleTime: Infinity,
  });
}

/**
 * Add a sequence's automatic style to the team library (#1213). The style row
 * keeps its id, so the sequence badge only needs the detail + list refreshed.
 */
export function usePromoteSequenceStyle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sequenceId: string; name: string }) =>
      promoteSequenceStyleFn({ data: input }),
    onSuccess: (style) => {
      queryClient.setQueryData<Style>(styleKeys.detail(style.id), style);
      void queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}
