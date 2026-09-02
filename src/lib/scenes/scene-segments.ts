/**
 * Scene render-segment view model (#986 / #990) — the client-facing shape of a
 * scene's video render units.
 *
 * The render unit is the **segment** (a contiguous shot-subset of one scene),
 * not the shot: a scene is tiled into ≤cap segments (`render_segments`) and each
 * segment's video accumulates versions in `video_variants`, with the segment's
 * `selectedVideoVersionId` pointing at the chosen one. Per-shot rendering is the
 * degenerate one-shot-per-segment case that's true for every scene today (the
 * analysis pipeline still emits one shot per scene), so this view degrades to
 * "one segment == one shot" until multi-shot analysis (#910) lands.
 *
 * `SequenceSegment` is what `getSequenceSegmentsFn` returns; membership
 * (`shotIds`) is authoritative and ordered. The UI groups its already-loaded
 * shots into segments via {@link groupShotsBySegment} and looks the video data
 * up by segment id.
 */

import type { VideoManifestEntry, VideoVariant } from '@/lib/db/schema';
import type { ShotView } from '@/lib/shots/shot-view';

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
 * own singleton group so the strip still accounts for it.
 */
export type SegmentGroup = {
  segmentId: string | null;
  segment: SequenceSegment | null;
  shots: ShotView[];
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
  manifest: readonly Pick<
    VideoManifestEntry,
    'shotId' | 'motionPromptVersionId' | 'frameVersionId'
  >[];
};
export type SegmentShotInput = {
  id: string;
  renderSegmentId: string | null;
  selectedMotionPromptVersionId: string | null;
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
 * motion-prompt version that is no longer the shot's selected one. Comparing the
 * stored references against the shots' *current* pointers (rather than rehashing)
 * is the derivation the schema doc calls out, and it sidesteps false positives
 * from non-referenced inputs like a re-snapped duration. A manifest entry whose
 * shot no longer exists (deleted/re-tiled) reads as stale, not fresh. An entry
 * with both version ids null is unknown provenance (legacy / unpinned trigger)
 * and is not stale — same contract as a null `inputHash`.
 */
export function isSelectedVersionStale(
  selected: SegmentVersionInput | undefined,
  currentMotionByShot: ReadonlyMap<string, string | null>,
  currentFrameByShot: ReadonlyMap<string, string | null>
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
    return (
      entry.motionPromptVersionId !== currentMotion ||
      entry.frameVersionId !== currentFrame
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

  // Each shot's current anchor-frame selected image version (role 'first').
  const currentFrameByShot = new Map<string, string | null>();
  for (const frame of input.frames) {
    if (frame.role !== 'first') continue;
    currentFrameByShot.set(frame.shotId, frame.selectedImageVersionId);
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
        currentFrameByShot
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
