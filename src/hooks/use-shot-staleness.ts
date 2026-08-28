import { getShotStalenessBatchFn, getShotStalenessFn } from '@/functions/shots';
import type { ArtifactStaleness } from '@/lib/shots/shot-staleness';
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

/**
 * Per-artifact staleness state — see `computeShotStaleness` for the state
 * semantics. `ArtifactStaleness` is imported rather than redeclared so the
 * client and server can't drift on the vocabulary. Only `'stale'` drives UI
 * regenerate actions: `'untracked'` (no hash) and `'unknown'` (check failed)
 * both mean "no opinion to surface as stale", `'updating'` means a job is
 * already fixing it (#1085), and `'generating'` means the sequence is mid-run
 * so no verdict was computed at all (#1121). The predicates below deliberately
 * match none of the last three as stale, so a `'generating'` shot renders
 * exactly nothing — no banner, no chip, no dot.
 */

/** The tracked artifacts, and the source of truth for `ShotStaleness`'s keys. */
const SHOT_ARTIFACTS = ['thumbnail', 'visualPrompt', 'motionPrompt'] as const;

export type ShotArtifact = (typeof SHOT_ARTIFACTS)[number];

/**
 * Client-facing staleness (wire shape). Server `ShotStalenessResult` also
 * carries `liveHashes` for enqueue paths; those never cross the wire.
 */
export type ShotStaleness = Record<ShotArtifact, ArtifactStaleness> & {
  /** Inputs edited since the stale artifacts were generated (#1194). */
  causes: string[];
};

/** Which of the shot's artifacts are out of date, if any. */
const staleArtifacts = (staleness: ShotStaleness | undefined): ShotArtifact[] =>
  SHOT_ARTIFACTS.filter((artifact) => staleness?.[artifact] === 'stale');

/** Any artifact on the shot out of date? ('updating' is NOT stale — a job is
 * already fixing it, so it must not re-arm Update all.) */
export const shotIsStale = (staleness: ShotStaleness | undefined): boolean =>
  staleArtifacts(staleness).length > 0;

/** Any artifact with a live pending claim — a regeneration is in flight
 * server-side (#1085). Drives the spinner form of the indicators. */
export const shotIsUpdating = (staleness: ShotStaleness | undefined): boolean =>
  SHOT_ARTIFACTS.some((artifact) => staleness?.[artifact] === 'updating');

/**
 * Any artifact whose comparison failed. Surfaced separately from `shotIsStale`
 * so a broken check reads as "couldn't check" rather than as "up to date".
 */
export const shotStalenessUnknown = (
  staleness: ShotStaleness | undefined
): boolean =>
  SHOT_ARTIFACTS.some((artifact) => staleness?.[artifact] === 'unknown');

/**
 * Invalidation target for anything that moves a shot's staleness (prompt
 * regen, image/video set, duration edit, script save). The per-shot,
 * scene-scoped and sequence-scoped entries all live under this prefix, so
 * invalidating the namespace keeps the shot indicators AND the scene/sequence
 * summaries / left-rail dots in step — a per-shot key invalidation would
 * leave the batched entries stale.
 */
export const shotStalenessNamespace = ['shot-staleness'] as const;

const shotStalenessKey = (shotId: string | undefined) =>
  [...shotStalenessNamespace, shotId] as const;

/**
 * Batched keys live under the same `'shot-staleness'` namespace so the
 * existing namespace invalidations (script save, realtime events) refresh
 * them too. No collision with `shotStalenessKey`: shot ids are ULIDs, never
 * `'scene'`/`'sequence'`.
 */
const sceneShotStalenessKey = (sceneId: string | undefined) =>
  [...shotStalenessNamespace, 'scene', sceneId] as const;
const sequenceShotStalenessKey = (sequenceId: string) =>
  [...shotStalenessNamespace, 'sequence', sequenceId] as const;

const isBatchedKey = (key: readonly unknown[]) =>
  key[1] === 'scene' || key[1] === 'sequence';

/**
 * Optimistically mark one artifact fresh everywhere it is cached — the shot's
 * own entry plus the batched entries the left-rail dots and scope summary read
 * from, which would otherwise keep showing the shot stale. Returns a rollback
 * for the mutation's `onError`.
 */
export function markArtifactFresh(
  queryClient: QueryClient,
  shotId: string,
  artifact: ShotArtifact
): () => void {
  const rollbacks: Array<() => void> = [];

  const perShotKey = shotStalenessKey(shotId);
  const perShot = queryClient.getQueryData<ShotStaleness>(perShotKey);
  if (perShot) {
    queryClient.setQueryData<ShotStaleness>(perShotKey, {
      ...perShot,
      [artifact]: 'fresh',
    });
    rollbacks.push(() => queryClient.setQueryData(perShotKey, perShot));
  }

  const batched = queryClient.getQueriesData<Record<string, ShotStaleness>>({
    queryKey: shotStalenessNamespace,
    predicate: (query) => isBatchedKey(query.queryKey),
  });
  for (const [key, byShot] of batched) {
    const entry = byShot?.[shotId];
    if (!byShot || !entry) continue;
    queryClient.setQueryData(key, {
      ...byShot,
      [shotId]: { ...entry, [artifact]: 'fresh' },
    });
    rollbacks.push(() => queryClient.setQueryData(key, byShot));
  }

  return () => {
    for (const rollback of rollbacks) rollback();
  };
}

/**
 * Shared query for shot staleness — consumers must use this hook rather than
 * an inline `useQuery`, and invalidate via `shotStalenessNamespace` so the
 * batched entries move with it.
 */
export function useShotStaleness(args: {
  sequenceId: string;
  shotId: string | undefined;
}) {
  const { sequenceId, shotId } = args;
  return useQuery<ShotStaleness>({
    queryKey: shotStalenessKey(shotId),
    queryFn: () => {
      if (!shotId) throw new Error('shotId required');
      return getShotStalenessFn({ data: { sequenceId, shotId } });
    },
    enabled: !!shotId,
    staleTime: 30_000,
  });
}

/**
 * Fetch the batch and prime the per-shot `shotStalenessKey` entries so
 * landing on a shot from the stale-shot navigation doesn't refire the
 * single-shot query.
 */
async function fetchAndPrimeBatch(
  queryClient: QueryClient,
  data: { sequenceId: string; sceneId?: string }
): Promise<Record<string, ShotStaleness>> {
  const byShot = await getShotStalenessBatchFn({ data });
  for (const [shotId, staleness] of Object.entries(byShot)) {
    queryClient.setQueryData<ShotStaleness>(
      shotStalenessKey(shotId),
      staleness
    );
  }
  return byShot;
}

/** Batched staleness for every shot in a scene (#1077), keyed by shot id. */
export function useSceneShotStaleness(args: {
  sequenceId: string;
  sceneId: string | undefined;
}) {
  const { sequenceId, sceneId } = args;
  const queryClient = useQueryClient();
  return useQuery<Record<string, ShotStaleness>>({
    queryKey: sceneShotStalenessKey(sceneId),
    queryFn: () => {
      if (!sceneId) throw new Error('sceneId required');
      return fetchAndPrimeBatch(queryClient, { sequenceId, sceneId });
    },
    enabled: !!sceneId,
    staleTime: 30_000,
  });
}

/**
 * Sequence-wide staleness (#1077), keyed by shot id. The scenes rail shows
 * every shot, so the left-rail dots need every shot's verdict — not just
 * the in-focus scene. `enabled` still lets a caller skip the hash recompute
 * (tests, or a surface that isn't showing the rail).
 */
export function useSequenceShotStaleness(args: {
  sequenceId: string;
  enabled?: boolean;
}) {
  const { sequenceId, enabled = true } = args;
  const queryClient = useQueryClient();
  return useQuery<Record<string, ShotStaleness>>({
    queryKey: sequenceShotStalenessKey(sequenceId),
    queryFn: () => fetchAndPrimeBatch(queryClient, { sequenceId }),
    enabled: enabled && !!sequenceId,
    staleTime: 30_000,
  });
}
