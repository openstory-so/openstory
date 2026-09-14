/**
 * Pack a motion-batch shot list into in-clip segments (#1510).
 *
 * Capable models (Seedance / H3 / Kling / Omni) tile a scene's shots into
 * ≤cap contiguous generations whose duration is the sum of the stored
 * timings. Grok (and any mixed batch that includes it) stays one generation
 * per shot. Mixed-capability batches do not pack — re-tiling per model is
 * #953.
 *
 * `tileSceneIntoSegments` does the grouping; this module is the live caller.
 */

import {
  DEFAULT_VIDEO_MODEL,
  videoModelSupportsInClipMultiShot,
  type ImageToVideoModel,
} from '@/models/models';
import {
  resolveSegmentCapMs,
  resolveSegmentMinMs,
  tileSceneIntoSegments,
} from './render-segments';

export type PackableMotionShot = {
  shotId: string;
  sceneId?: string | null;
  duration?: number;
  model?: ImageToVideoModel;
  /**
   * Persisted clip membership. Consecutive shots sharing a non-null id stay
   * that clip on regenerate; null runs are tiled fresh. A 1:1 segment uses
   * the shot's own id, so it does not absorb neighbours.
   */
  renderSegmentId?: string | null;
};

export type PackMotionOptions<S extends PackableMotionShot> = {
  /**
   * After duration tiling, peel the last member while this is false. A
   * 1-shot tile is always emitted even when it does not fit — that shot is
   * the existing per-shot truncate path, not a packed clip.
   */
  promptFits?: (members: readonly S[]) => boolean;
};

export type PackedMotionMember<S> = S & {
  /**
   * Members this generation covers, in story order. Absent on a 1-shot
   * (unpacked or degenerate) job so existing single-shot payloads stay
   * byte-identical.
   */
  coveredShots?: S[];
};

/**
 * True when every model this batch will generate can cut inside a clip.
 * One incapable model (Grok) keeps the whole batch on today's 1:1 path.
 */
export function batchPacksInClipMultiShot(
  models: readonly ImageToVideoModel[]
): boolean {
  return models.length > 0 && models.every(videoModelSupportsInClipMultiShot);
}

/**
 * Tile `shots` into generation jobs for `videoModels`. Packing uses the
 * tightest cap among those models so every model in the batch shares the
 * same membership. Shots without a `sceneId` never coalesce.
 */
export function packMotionBatchShots<S extends PackableMotionShot>(
  shots: readonly S[],
  videoModels: readonly ImageToVideoModel[] | undefined,
  options?: PackMotionOptions<S>
): PackedMotionMember<S>[] {
  if (shots.length === 0) return [];

  const models = resolveBatchModels(shots, videoModels);
  if (!batchPacksInClipMultiShot(models)) {
    return [...shots];
  }

  const capMs = Math.min(...models.map(resolveSegmentCapMs));
  const minMs = Math.max(...models.map(resolveSegmentMinMs));
  const packed: PackedMotionMember<S>[] = [];
  for (const group of groupByScene(shots)) {
    packed.push(...packSceneGroup(group, capMs, minMs, options?.promptFits));
  }
  return packed;
}

function packSceneGroup<S extends PackableMotionShot>(
  group: readonly S[],
  capMs: number,
  minMs: number,
  promptFits: PackMotionOptions<S>['promptFits']
): PackedMotionMember<S>[] {
  const packed: PackedMotionMember<S>[] = [];
  for (const run of splitStickyRuns(group)) {
    const sticky = (run[0]?.renderSegmentId ?? null) !== null;
    const byId = new Map(run.map((shot) => [shot.shotId, shot]));
    // A persisted clip is atomic: peeling a member would leave it on the
    // old segment with a video it was not in. Unrendered (null) runs may
    // split on duration and prompt length; those shots become the next clip.
    const tiles = sticky
      ? [tileOf(run)]
      : fitRun(run, capMs, minMs, promptFits);
    for (const tile of tiles) {
      const members = tile.shotIds.flatMap((id) => {
        const shot = byId.get(id);
        return shot ? [shot] : [];
      });
      const first = members[0];
      if (!first) continue;
      // Grok leftover override: the shot opted out of the packing model.
      // One take per clip — do not invent in-clip cuts Grok cannot follow.
      if (first.model && !videoModelSupportsInClipMultiShot(first.model)) {
        packed.push(...members);
        continue;
      }
      if (members.length === 1) {
        packed.push(first);
        continue;
      }
      packed.push({
        ...first,
        duration: tile.durationMs / 1000,
        coveredShots: members,
      });
    }
  }
  return packed;
}

/**
 * Consecutive shots that share a `renderSegmentId` (including a run of
 * nulls) stay together. Distinct ids — a 1:1 degenerate segment uses the
 * shot's own id — never coalesce with their neighbours.
 */
function packsInClip(shot: PackableMotionShot): boolean {
  return !shot.model || videoModelSupportsInClipMultiShot(shot.model);
}

function splitStickyRuns<S extends PackableMotionShot>(
  group: readonly S[]
): S[][] {
  const runs: S[][] = [];
  for (const shot of group) {
    const last = runs[runs.length - 1];
    const id = shot.renderSegmentId ?? null;
    const lastId = last?.[0]?.renderSegmentId ?? null;
    const lastPacks = last?.[0] ? packsInClip(last[0]) : false;
    // Grok leftover shots are barriers: packing them into a Seedance
    // neighbour would snap a 1s insert that the user sent to Grok.
    if (
      last &&
      (id ?? '') === (lastId ?? '') &&
      lastPacks &&
      packsInClip(shot)
    ) {
      last.push(shot);
      continue;
    }
    runs.push([shot]);
  }
  return runs;
}

function fitRun<S extends PackableMotionShot>(
  shots: readonly S[],
  capMs: number,
  minMs: number,
  promptFits: PackMotionOptions<S>['promptFits']
): { shotIds: string[]; durationMs: number }[] {
  const durationTiles = tileSceneIntoSegments(
    shots.map((shot) => ({
      id: shot.shotId,
      durationMs: durationMsOf(shot),
    })),
    capMs,
    minMs
  );
  if (!promptFits) return durationTiles;
  const byId = new Map(shots.map((shot) => [shot.shotId, shot]));
  return durationTiles.flatMap((tile) =>
    splitTileByPrompt(tile, byId, promptFits)
  );
}

function splitTileByPrompt<S extends PackableMotionShot>(
  tile: { shotIds: string[]; durationMs: number },
  byId: ReadonlyMap<string, S>,
  promptFits: (members: readonly S[]) => boolean
): { shotIds: string[]; durationMs: number }[] {
  const members = tile.shotIds.flatMap((id) => {
    const shot = byId.get(id);
    return shot ? [shot] : [];
  });
  const out: { shotIds: string[]; durationMs: number }[] = [];
  let current: S[] = [];
  for (const shot of members) {
    const candidate = [...current, shot];
    if (current.length > 0 && !promptFits(candidate)) {
      out.push(tileOf(current));
      current = [shot];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) out.push(tileOf(current));
  return out;
}

function tileOf<S extends PackableMotionShot>(
  members: readonly S[]
): { shotIds: string[]; durationMs: number } {
  return {
    shotIds: members.map((shot) => shot.shotId),
    durationMs: members.reduce((sum, shot) => sum + durationMsOf(shot), 0),
  };
}

function resolveBatchModels<S extends PackableMotionShot>(
  shots: readonly S[],
  videoModels: readonly ImageToVideoModel[] | undefined
): ImageToVideoModel[] {
  if (videoModels && videoModels.length > 0) {
    return [...new Set(videoModels)];
  }
  const fromShots = [
    ...new Set(shots.flatMap((shot) => (shot.model ? [shot.model] : []))),
  ];
  return fromShots.length > 0 ? fromShots : [DEFAULT_VIDEO_MODEL];
}

function groupByScene<S extends PackableMotionShot>(
  shots: readonly S[]
): S[][] {
  const groups: S[][] = [];
  const indexByKey = new Map<string, number>();
  for (const shot of shots) {
    const key = shot.sceneId ? `scene:${shot.sceneId}` : `shot:${shot.shotId}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      groups[existing]?.push(shot);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push([shot]);
  }
  return groups;
}

/**
 * Members of the in-clip generation that covers `shotId`, in story order.
 * A 1-shot (or Grok) job is `[that shot]`.
 */
export function coveredMembersForShot<S extends PackableMotionShot>(
  shots: readonly S[],
  shotId: string,
  videoModels: readonly ImageToVideoModel[],
  options?: PackMotionOptions<S>
): S[] {
  const packed = packMotionBatchShots(shots, videoModels, options);
  for (const job of packed) {
    const members = job.coveredShots ?? [job];
    if (members.some((member) => member.shotId === shotId)) {
      return members;
    }
  }
  return shots.filter((shot) => shot.shotId === shotId);
}

function durationMsOf(shot: PackableMotionShot): number {
  const seconds = shot.duration;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  return 3000;
}
