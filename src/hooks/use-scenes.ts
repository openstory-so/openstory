import {
  getComposedScriptFn,
  getScenesFn,
  updateSceneScriptFn,
} from '@/functions/scenes';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { SceneRow } from '@/lib/db/schema';
import { sceneFacetKeys } from '@/hooks/use-scene-facets';
import { sequenceKeys } from '@/hooks/use-sequences';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import { shotKeys } from '@/hooks/use-shots';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const sceneKeys = {
  all: ['scenes'] as const,
  list: (sequenceId: string) => [...sceneKeys.all, 'list', sequenceId] as const,
  composedScript: (sequenceId: string) =>
    [...sceneKeys.all, 'composed-script', sequenceId] as const,
};

/** Composed sequence script from selected scene versions (#1030). */
export function useComposedScript(sequenceId?: string) {
  return useQuery({
    queryKey: sceneKeys.composedScript(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getComposedScriptFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

/** A scene row plus its SELECTED script (#1030) — the row holds no script. */
export type SceneWithScript = SceneRow & {
  script: Scene['originalScript'] | null;
};

/** Ordered scenes for a sequence — the editor groups shots under these (#909). */
export function useScenesBySequence(sequenceId?: string) {
  return useQuery<SceneWithScript[]>({
    queryKey: sceneKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getScenesFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

/**
 * Save a scene's script (#1030) — one mutation shared by every surface that
 * edits it (the inspector's Script facet and each block of the script
 * document), so they can't drift on which caches a script write invalidates.
 *
 * A script edit moves prompt-input-hash staleness on every shot in the scene,
 * so the shot list and the composed document both have to refetch; the shot
 * ids affected aren't known here, so the list invalidation covers them.
 */
export function useSaveSceneScript(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sceneId: string; extract: string }) =>
      updateSceneScriptFn({
        data: {
          sequenceId,
          sceneId: input.sceneId,
          extract: input.extract,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sceneKeys.composedScript(sequenceId),
        }),
        // A script edit can auto-link @-mentioned cast/elements/locations into
        // the scene's continuity (#1341): refetch the scene rows and the
        // server-resolved facet membership the Cast tab reads.
        queryClient.invalidateQueries({ queryKey: sceneKeys.list(sequenceId) }),
        queryClient.invalidateQueries({
          queryKey: sceneFacetKeys.maps(sequenceId),
        }),
        // Staleness is per-shot and keyed by shot id; the scene's shots aren't
        // enumerated here, so drop the whole staleness namespace.
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

// NOTE: no `useUpdateSceneModel` (#1066) — a scene has no model to write. The
// editor's model pick is a per-request choice passed to the generate call; it
// becomes durable when the version it produces is selected, and
// `useSequenceSelectedModels` reads it back.
