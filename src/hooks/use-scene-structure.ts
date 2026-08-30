/**
 * Structure CRUD mutations for the Scenes editor left rail (#1108 Phase 1):
 * scene/shot create, reorder, soft-delete + restore, and scene narrative
 * edits. Reorders patch the cache optimistically (reordering is the one place
 * a refetch round-trip visibly lags the click) and reconcile on settle; a
 * pure reorder is hash-inert by design, so it never touches staleness keys.
 * Restores are plain async fns over the app-level QueryClient — undo-toast
 * closures outlive the removing component (see `restoreSequenceCharacter`).
 */

import {
  createSceneFn,
  reorderScenesFn,
  restoreSceneFn,
  softDeleteSceneFn,
  updateSceneFn,
} from '@/functions/scenes';
import {
  createShotFn,
  deleteShotFn,
  reorderShotsFn,
  restoreShotFn,
} from '@/functions/shots';
import { sceneKeys, type SceneWithScript } from '@/hooks/use-scenes';
import { segmentKeys } from '@/hooks/use-segments';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import { shotKeys } from '@/hooks/use-shots';
import type { ShotView } from '@/lib/shots/shot-view';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

function invalidateStructure(
  queryClient: QueryClient,
  sequenceId: string,
  opts: { staleness?: boolean } = {}
): void {
  void queryClient.invalidateQueries({ queryKey: sceneKeys.list(sequenceId) });
  void queryClient.invalidateQueries({
    queryKey: sceneKeys.composedScript(sequenceId),
  });
  void queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) });
  void queryClient.invalidateQueries({
    queryKey: segmentKeys.list(sequenceId),
  });
  void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
  if (opts.staleness) {
    void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
  }
}

/** Append a scene (with its first shot unless `withShot: false`). */
export function useCreateScene(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: { title?: string; withShot?: boolean }) =>
      createSceneFn({ data: { sequenceId, ...input } }),
    onSuccess: ({ scene }) => {
      // Paint the new scene before the refetch round-trip. Without this the
      // rail stays on "No scenes yet" until list queries settle — e2e (and
      // a slow D1) can miss the group entirely (#1108 flake, #1384).
      queryClient.setQueryData<SceneWithScript[]>(
        sceneKeys.list(sequenceId),
        (old) => {
          const next = old ?? [];
          if (next.some((row) => row.id === scene.id)) return next;
          return [...next, { ...scene, script: null }];
        }
      );
      invalidateStructure(queryClient, sequenceId);
    },
  });
}

/** Append a shot to a scene (server auto-numbers the slot). */
export function useCreateShot(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sceneId: string }) =>
      // durationMs omitted so the column's 3000ms default applies.
      createShotFn({ data: { sequenceId, sceneId: input.sceneId } }),
    onSuccess: () => invalidateStructure(queryClient, sequenceId),
  });
}

/**
 * Edit a scene's narrative fields. Location / timeOfDay / storyBeat sit in
 * the prompt-hash scene surface, so the shots' prompts re-stale by
 * derivation — refresh the staleness namespace for the dots. Title is a
 * display label and does not participate.
 */
export function useUpdateScene(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sceneId: string;
      title?: string;
      location?: string;
      timeOfDay?: string;
      storyBeat?: string;
    }) => updateSceneFn({ data: { sequenceId, ...input } }),
    onSuccess: () =>
      invalidateStructure(queryClient, sequenceId, { staleness: true }),
  });
}

/** Reorder all live scenes; optimistic, reconciled on settle. */
export function useReorderScenes(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `reorder-scenes-${sequenceId}` },
    mutationFn: (sceneIds: SceneWithScript['id'][]) =>
      reorderScenesFn({ data: { sequenceId, sceneIds } }),
    onMutate: async (sceneIds) => {
      const key = sceneKeys.list(sequenceId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SceneWithScript[]>(key);
      queryClient.setQueryData<SceneWithScript[]>(key, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((scene) => [scene.id, scene]));
        const ordered = sceneIds.flatMap((id) => {
          const scene = byId.get(id);
          return scene ? [scene] : [];
        });
        if (ordered.length !== old.length) return old;
        return ordered.map((scene, orderIndex) => ({ ...scene, orderIndex }));
      });
      return { previous };
    },
    onError: (_error, _sceneIds, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sceneKeys.list(sequenceId), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: sceneKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: sceneKeys.composedScript(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: segmentKeys.list(sequenceId),
      });
    },
  });
}

/** Reorder one scene's live shots; optimistic, reconciled on settle. */
export function useReorderShots(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `reorder-shots-${sequenceId}` },
    mutationFn: (input: { sceneId: string; shotIds: string[] }) =>
      reorderShotsFn({ data: { sequenceId, ...input } }),
    onMutate: async ({ sceneId, shotIds }) => {
      const key = shotKeys.list(sequenceId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ShotView[]>(key);
      queryClient.setQueryData<ShotView[]>(key, (old) => {
        if (!old) return old;
        // Splice the scene's shots back into their slots in the new order;
        // shots of other scenes keep their positions.
        const sceneShots = new Map(
          old.filter((s) => s.sceneId === sceneId).map((s) => [s.id, s])
        );
        const reordered = shotIds.flatMap((id) => {
          const shot = sceneShots.get(id);
          return shot ? [shot] : [];
        });
        if (reordered.length !== sceneShots.size) return old;
        let cursor = 0;
        return old.map((shot) =>
          shot.sceneId === sceneId ? (reordered[cursor++] ?? shot) : shot
        );
      });
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(shotKeys.list(sequenceId), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: segmentKeys.list(sequenceId),
      });
    },
  });
}

/** Soft-delete a scene and its live shots (undo via `restoreScene`). */
export function useSoftDeleteScene(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sceneId: string }) =>
      softDeleteSceneFn({ data: { sequenceId, ...input } }),
    onSuccess: () =>
      invalidateStructure(queryClient, sequenceId, { staleness: true }),
  });
}

/** Soft-delete a shot (undo via `restoreShot`). */
export function useSoftDeleteShot(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { shotId: string }) =>
      deleteShotFn({ data: { sequenceId, ...input } }),
    onSuccess: () =>
      invalidateStructure(queryClient, sequenceId, { staleness: true }),
  });
}

export async function restoreScene(
  queryClient: QueryClient,
  data: { sequenceId: string; sceneId: string }
): Promise<void> {
  await restoreSceneFn({ data });
  invalidateStructure(queryClient, data.sequenceId, { staleness: true });
}

export async function restoreShot(
  queryClient: QueryClient,
  data: { sequenceId: string; shotId: string }
): Promise<void> {
  await restoreShotFn({ data });
  invalidateStructure(queryClient, data.sequenceId, { staleness: true });
}
