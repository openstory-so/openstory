/**
 * Scene render-segment view model (#986 / #990) — the client-facing shape of a
 * scene's video render units.
 *
 * The render unit is the **segment** (a contiguous shot-subset of one scene),
 * not the shot: a scene is tiled into ≤cap segments (`render_segments`) and each
 * segment's video accumulates versions in `video_variants`, with the segment's
 * `selectedVideoVersionId` pointing at the chosen one. Persisted
 * `renderSegmentId` groups are the clip; unrendered runs are tiled as a
 * generate preview. Shots that meet the model minimum stay 1:1; shorter shots
 * are grouped only as needed to avoid under-minimum leftovers (#1658).
 *
 * `SequenceSegment` is what `getSequenceSegmentsFn` returns; membership
 * (`shotIds`) is authoritative and ordered. The UI groups its already-loaded
 * shots via {@link groupShotsForSceneList} (persisted clips + a generate
 * preview of unrendered runs) and looks the video data up by segment id.
 */

import {
  videoModelSupportsInClipMultiShot,
  type ImageToVideoModel,
} from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
import {
  DEFAULT_SEGMENT_CAP_MS,
  tileSceneIntoSegments,
} from '@/motion/tile-segments';
import type {
  VideoManifestEntry,
  VideoVariant,
} from '@/platform/server/db/schema';
import { durationSecondsOf } from './packed-clip-window';
import type { ShotView } from './shot-view';

/** One video render (version) of a segment, trimmed to what the editor shows. */
export type SegmentVideoVersion = Pick<
  VideoVariant,
  'id' | 'model' | 'resolution' | 'status' | 'url' | 'createdAt'
>;

/** A scene's render segment with its video versions + selection. */
export type SequenceSegment = {
  /** `render_segments.id`. */
  id: string;
  sceneId: string;
  /** Ordered shot ids this segment covers (by `shots.orderIndex`). */
  shotIds: string[];
  /** The segment's chosen version, or null when nothing is selected yet. */
  selectedVersionId: string | null;
  /**
   * The resolved selected version. Null when nothing is selected — AND when
   * `selectedVersionId` points at a discarded version (excluded from
   * `versions`): the dangling selection then renders as "nothing selected,
   * not stale". The server logs that case.
   */
  selectedVersion: SegmentVideoVersion | null;
  /** All non-discarded versions, oldest-first (the re-roll history). */
  versions: SegmentVideoVersion[];
  /**
   * The model of the selected version, else the newest version's model, else
   * null (no version yet). Drives the pill/label without a second lookup.
   */
  model: string | null;
  /**
   * The selected version's manifest references a frame or motion-prompt
   * version that is no longer a covered shot's selected one (the shot's inputs
   * changed after the render). `false` when nothing is selected.
   */
  stale: boolean;
};

/**
 * A contiguous run of scoped shots that share one segment. `segment` is null for
 * shots not yet assigned to a segment (never rendered) — each such shot is its
 * own singleton group so the strip still accounts for it, unless
 * {@link groupShotsForSceneList} tiles a planned pack onto them.
 */
export type SegmentGroup = {
  segmentId: string | null;
  segment: SequenceSegment | null;
  shots: ShotView[];
  /**
   * Generate-picker model when this wrap is a packing preview, not a
   * persisted clip. Set on 2+ unrendered shots that fit under the cap, and
   * on a 1-shot leftover (sum < model min) so the strip can show the
   * snap/Grok dropdown.
   */
  plannedModel?: ImageToVideoModel;
  /** Planned pack whose sum is under the model floor. */
  belowMin?: true;
};

/**
 * Group ordered shots into their render segments for the shot strip. Shots are
 * sorted by `orderIndex` first (segment identity depends on order), then split
 * into contiguous runs sharing a `renderSegmentId`; a null `renderSegmentId`
 * (unrendered shot) yields a singleton group with `segment: null`.
 */
export function groupShotsBySegment(
  shots: readonly ShotView[],
  segmentsById: ReadonlyMap<string, SequenceSegment>
): SegmentGroup[] {
  // Callers pass shots already in hierarchical order (scene, then shot
  // number) — the read paths sort them that way.
  const ordered = shots;
  const groups: SegmentGroup[] = [];

  for (const shot of ordered) {
    const segmentId = shot.renderSegmentId;
    const last = groups[groups.length - 1];
    // Null-segment shots never coalesce (no shared identity) — each is its own
    // singleton so it still renders in the strip without implying a video.
    if (segmentId !== null && last && last.segmentId === segmentId) {
      last.shots.push(shot);
      continue;
    }
    groups.push({
      segmentId,
      segment:
        segmentId !== null ? (segmentsById.get(segmentId) ?? null) : null,
      shots: [shot],
    });
  }

  return groups;
}

/**
 * Shot-list grouping: persisted render segments stay as they are; contiguous
 * unrendered shots are tiled with the generate-picker model so the strip can
 * preview the next pack (#1510). Grok stays unwrapped. A 1-shot tile that
 * meets min stays flat; a 1-shot leftover is wrapped so the strip can offer
 * snap vs Grok. A run that already has a `renderSegmentId` is never re-tiled
 * — the existing clip's membership wins until a new render lands.
 */
export function groupShotsForSceneList(
  shots: readonly ShotView[],
  segmentsById: ReadonlyMap<string, SequenceSegment>,
  videoModel: ImageToVideoModel
): SegmentGroup[] {
  const persisted = groupShotsBySegment(shots, segmentsById);
  if (!videoModelSupportsInClipMultiShot(videoModel)) return persisted;

  const grid = durationGridForModel(videoModel);
  const capMs =
    grid.length > 0 ? Math.max(...grid) * 1000 : DEFAULT_SEGMENT_CAP_MS;
  const minMs = grid.length > 0 ? Math.min(...grid) * 1000 : 0;
  const out: SegmentGroup[] = [];
  let pending: ShotView[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    const tiles = tileSceneIntoSegments(
      pending.map((shot) => ({
        id: shot.id,
        durationMs: Math.round(durationSecondsOf(shot.durationMs) * 1000),
      })),
      capMs,
      minMs
    );
    const byId = new Map(pending.map((shot) => [shot.id, shot]));
    for (const tile of tiles) {
      const members = tile.shotIds.flatMap((id) => {
        const member = byId.get(id);
        return member ? [member] : [];
      });
      if (members.length === 0) continue;
      const leftover = tile.belowMin === true;
      out.push(
        members.length > 1 || leftover
          ? {
              segmentId: null,
              segment: null,
              shots: members,
              plannedModel: videoModel,
              ...(leftover ? { belowMin: true as const } : {}),
            }
          : { segmentId: null, segment: null, shots: members }
      );
    }
    pending = [];
  };

  for (const group of persisted) {
    if (group.segmentId === null) {
      pending.push(...group.shots);
      continue;
    }
    flushPending();
    out.push(group);
  }
  flushPending();
  return out;
}

/**
 * Minimal structural inputs for {@link assembleSequenceSegments} — the fields
 * the assembly reads off the DB rows, so it stays a pure, testable function.
 */
export type SegmentRowInput = {
  id: string;
  sceneId: string;
  selectedVideoVersionId: string | null;
};
export type SegmentVersionInput = SegmentVideoVersion & {
  renderSegmentId: string;
  manifest: readonly (Pick<
    VideoManifestEntry,
    'shotId' | 'motionPromptVersionId' | 'frameVersionId'
  > & {
    /** Absent on pre-pointer rows; treated as voiceless. */
    audioSourceKey?: string | null;
  })[];
};
export type SegmentShotInput = {
  id: string;
  renderSegmentId: string | null;
  selectedMotionPromptVersionId: string | null;
  /**
   * Does this shot render from reference sheets rather than a still?
   * `rendersReferenceOnly(shot, sequence)` — REQUIRED, not defaulted: such a
   * shot has no frame pointer to compare, and getting it wrong silently marks
   * every clip Stale (or hides a real staleness). Required so a new caller
   * has to answer it rather than inherit a guess.
   */
  rendersReferenceOnly: boolean;
};
export type SegmentFrameInput = {
  shotId: string;
  role: string;
  selectedImageVersionId: string | null;
};

function toVersion(v: SegmentVersionInput): SegmentVideoVersion {
  return {
    id: v.id,
    model: v.model,
    resolution: v.resolution,
    status: v.status,
    url: v.url,
    createdAt: v.createdAt,
  };
}

/**
 * A segment's selected version is stale when any covered shot's inputs have
 * moved on since the render — i.e. the version's manifest references a frame or
 * motion-prompt version that is no longer the shot's selected one, or the
 * bound dialogue-audio identity (`audioSourceKey`) no longer matches. Comparing
 * the stored references against the shots' *current* pointers (rather than
 * rehashing) is the derivation the schema doc calls out, and it sidesteps false
 * positives from non-referenced inputs like a re-snapped duration. A manifest
 * entry whose shot no longer exists (deleted/re-tiled) reads as stale, not
 * fresh. An entry with both version ids null is unknown provenance (legacy /
 * unpinned trigger) and is not stale — same contract as a null `inputHash`.
 */
export function isSelectedVersionStale(
  selected: SegmentVersionInput | undefined,
  currentMotionByShot: ReadonlyMap<string, string | null>,
  currentFrameByShot: ReadonlyMap<string, string | null>,
  currentAudioSourceKeyByShot: ReadonlyMap<string, string | null> = new Map()
): boolean {
  if (!selected) return false;
  return selected.manifest.some((entry) => {
    // Both ids null = unknown provenance (pre-#1380 storyboard clips, or a
    // trigger that forgot to pin). Same contract as a legacy null hash:
    // unknown is not stale, so a regression cannot mark every clip Stale.
    if (entry.motionPromptVersionId == null && entry.frameVersionId == null) {
      return false;
    }
    const currentMotion = currentMotionByShot.get(entry.shotId) ?? null;
    const currentFrame = currentFrameByShot.get(entry.shotId) ?? null;
    const currentAudio = currentAudioSourceKeyByShot.get(entry.shotId) ?? null;
    return (
      entry.motionPromptVersionId !== currentMotion ||
      entry.frameVersionId !== currentFrame ||
      (entry.audioSourceKey ?? null) !== currentAudio
    );
  });
}

/**
 * Assemble the client-facing {@link SequenceSegment} list from raw rows: ordered
 * shot membership, version history (oldest-first, as given), selected version,
 * denormalized model, and staleness. A segment with no shots pointing at it is
 * still returned with empty `shotIds` so a dangling selection stays inspectable.
 */
export function assembleSequenceSegments(input: {
  segments: readonly SegmentRowInput[];
  versions: readonly SegmentVersionInput[];
  shots: readonly SegmentShotInput[];
  frames: readonly SegmentFrameInput[];
  /**
   * Live dialogue-audio identity per shot (voice id + line + tone + TTS
   * model). Omitted keys are voiceless (`null`). Same pointer comparison as
   * motion-prompt / frame version ids.
   */
  currentAudioSourceKeyByShot?: ReadonlyMap<string, string | null>;
}): SequenceSegment[] {
  // Membership lives on the shot; callers pass shots already in hierarchical
  // order (scene, then shot number).
  const orderedShots = input.shots;
  const shotIdsBySegment = new Map<string, string[]>();
  const currentMotionByShot = new Map<string, string | null>();
  for (const shot of orderedShots) {
    currentMotionByShot.set(shot.id, shot.selectedMotionPromptVersionId);
    if (!shot.renderSegmentId) continue;
    const list = shotIdsBySegment.get(shot.renderSegmentId) ?? [];
    list.push(shot.id);
    shotIdsBySegment.set(shot.renderSegmentId, list);
  }

  // Each shot's current anchor-frame selected image version (role 'first'),
  // or `null` for a shot that renders from references — it animates from no
  // still, so it has no frame pointer, and the manifest records `null` to
  // match. Comparing a reference-only clip against a still it never received
  // marked it Stale the instant it finished, offering a paid re-render that
  // produced the identical clip for ever.
  const referenceOnlyShots = new Set(
    orderedShots.filter((shot) => shot.rendersReferenceOnly).map((s) => s.id)
  );
  const currentFrameByShot = new Map<string, string | null>();
  for (const frame of input.frames) {
    if (frame.role !== 'first') continue;
    currentFrameByShot.set(
      frame.shotId,
      referenceOnlyShots.has(frame.shotId) ? null : frame.selectedImageVersionId
    );
  }

  // Versions grouped by segment, preserving input order (oldest-first).
  const versionsBySegment = new Map<string, SegmentVersionInput[]>();
  for (const v of input.versions) {
    const list = versionsBySegment.get(v.renderSegmentId) ?? [];
    list.push(v);
    versionsBySegment.set(v.renderSegmentId, list);
  }

  return input.segments.map((segment): SequenceSegment => {
    const segVersions = versionsBySegment.get(segment.id) ?? [];
    const selected =
      segment.selectedVideoVersionId != null
        ? segVersions.find((v) => v.id === segment.selectedVideoVersionId)
        : undefined;
    const newest = segVersions[segVersions.length - 1];
    return {
      id: segment.id,
      sceneId: segment.sceneId,
      shotIds: shotIdsBySegment.get(segment.id) ?? [],
      selectedVersionId: segment.selectedVideoVersionId,
      selectedVersion: selected ? toVersion(selected) : null,
      versions: segVersions.map(toVersion),
      model: selected?.model ?? newest?.model ?? null,
      stale: isSelectedVersionStale(
        selected,
        currentMotionByShot,
        currentFrameByShot,
        input.currentAudioSourceKeyByShot
      ),
    };
  });
}

/**
 * A 1-based shot-span label from ordered shot numbers ("Shot 2" or "Shots 2–4").
 * Empty string for an empty list.
 */
export function formatShotSpan(numbers: readonly number[]): string {
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? `Shot ${first}` : `Shots ${first}–${last}`;
}
