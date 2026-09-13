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
import { resolveSegmentCapMs, tileSceneIntoSegments } from './render-segments';

export type PackableMotionShot = {
  shotId: string;
  sceneId?: string | null;
  duration?: number;
  model?: ImageToVideoModel;
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
  videoModels: readonly ImageToVideoModel[] | undefined
): PackedMotionMember<S>[] {
  if (shots.length === 0) return [];

  const models = resolveBatchModels(shots, videoModels);
  if (!batchPacksInClipMultiShot(models)) {
    return [...shots];
  }

  const capMs = Math.min(...models.map(resolveSegmentCapMs));
  const packed: PackedMotionMember<S>[] = [];
  for (const group of groupByScene(shots)) {
    const tiles = tileSceneIntoSegments(
      group.map((shot) => ({
        id: shot.shotId,
        durationMs: durationMsOf(shot),
      })),
      capMs
    );
    const byId = new Map(group.map((shot) => [shot.shotId, shot]));
    for (const tile of tiles) {
      const members = tile.shotIds.flatMap((id) => {
        const shot = byId.get(id);
        return shot ? [shot] : [];
      });
      const first = members[0];
      if (!first) continue;
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

function durationMsOf(shot: PackableMotionShot): number {
  const seconds = shot.duration;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  return 3000;
}
