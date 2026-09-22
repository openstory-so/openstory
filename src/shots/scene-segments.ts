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
  isValidImageToVideoModel,
  videoModelSupportsInClipMultiShot,
  type ImageToVideoModel,
} from '@/models/models';
import { referenceKeysMoved } from '@/motion/reference-provenance';
import { modelTakesDialogueAudio } from '@/motion/dialogue-tts';
import {
  raiseShotDurationToCoverAudio,
  resolveShotDuration,
} from '@/motion/resolve-shot-duration';
import { durationGridForModel } from '@/motion/model-capabilities';
import {
  DEFAULT_SEGMENT_CAP_MS,
  tileSceneIntoSegments,
} from '@/motion/tile-segments';
import type {
  MotionAudioClip,
  VideoManifestEntry,
  VideoVariant,
} from '@/platform/server/db/schema';
import { durationSecondsOf } from './packed-clip-window';
import type { ShotView } from './shot-view';

/** One video render (version) of a segment, trimmed to what the editor shows. */
export type SegmentVideoVersion = Pick<
  VideoVariant,
  'id' | 'model' | 'resolution' | 'status' | 'url' | 'createdAt' | 'draftTaskId'
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
    /** Absent on very old rows: unknown, never stale. */
    audioClipIds?: readonly string[];
    /** Absent on rows from before #1657: unknown, never stale. */
    referenceKeys?: readonly string[];
    /** Absent on rows from before #767's value snapshot. */
    durationMs?: number;
  })[];
};

/**
 * What a shot would be rendered from NOW, beyond its prompt and frame
 * pointers (#1657). A map that lacks a shot reads as "nothing bound" for
 * that input.
 */
export type LiveShotInputs = {
  /** Voice id + line + tone + model key per shot; `null` = voiceless. */
  audioSourceKeyByShot: ReadonlyMap<string, string | null>;
  /** Ids of the clips in the shot's working set (`shots.audioClips`). */
  audioClipIdsByShot: ReadonlyMap<string, readonly string[]>;
  /** `kind:entityId` → the provenance key a render would be sent now. */
  referenceIdentity: ReadonlyMap<string, string>;
  /** Raw `shots.durationMs` (unset/0 = no user duration, not compared). */
  durationMsByShot: ReadonlyMap<string, number | null>;
  /** Seconds of dialogue audio bound to the shot, for the audio raise. */
  audioSecondsByShot: ReadonlyMap<string, number>;
};
/** The half of {@link LiveShotInputs} that takes I/O; the rest is on the shot rows. */
export type LoadedShotInputs = Pick<
  LiveShotInputs,
  'audioSourceKeyByShot' | 'referenceIdentity'
>;
export type SegmentShotInput = {
  id: string;
  renderSegmentId: string | null;
  selectedMotionPromptVersionId: string | null;
  audioClips: readonly Pick<MotionAudioClip, 'id' | 'durationSeconds'>[] | null;
  durationMs: number | null;
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
    draftTaskId: v.draftTaskId,
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
  live: LiveShotInputs
): boolean {
  if (!selected) return false;
  return selected.manifest.some((entry, index) => {
    // Both ids null = unknown provenance (pre-#1380 storyboard clips, or a
    // trigger that forgot to pin). Same contract as a legacy null hash:
    // unknown is not stale, so a regression cannot mark every clip Stale.
    if (entry.motionPromptVersionId == null && entry.frameVersionId == null) {
      return false;
    }
    const currentMotion = currentMotionByShot.get(entry.shotId) ?? null;
    const currentFrame = currentFrameByShot.get(entry.shotId) ?? null;
    // Match the render triggers: models without an uploaded-audio input
    // receive no voiced lines and stamp a null key, even with voices enabled.
    // Keep the shared live key intact for the dialogue recording's own check.
    const currentAudio =
      entry.audioSourceKey == null &&
      isValidImageToVideoModel(selected.model) &&
      !modelTakesDialogueAudio(selected.model)
        ? null
        : (live.audioSourceKeyByShot.get(entry.shotId) ?? null);
    return (
      entry.motionPromptVersionId !== currentMotion ||
      entry.frameVersionId !== currentFrame ||
      ((entry.audioSourceKey ?? null) !== currentAudio &&
        !legacyPackedAudioMatches(selected, index, live)) ||
      audioClipsMoved(entry, live) ||
      referenceKeysMoved(entry.referenceKeys, live.referenceIdentity) ||
      durationMoved(entry, selected.model, live, selected.manifest.length > 1)
    );
  });
}

/**
 * Before #1720 the lead entry keyed the whole packed conversation. Accept
 * that exact historical stamp only while ALL of those live words/voices
 * still match. Other members and their recording IDs are compared normally.
 */
function legacyPackedAudioMatches(
  selected: SegmentVersionInput,
  index: number,
  live: LiveShotInputs
): boolean {
  if (index !== 0 || selected.manifest.length < 2) return false;
  const stamped = selected.manifest[0]?.audioSourceKey;
  if (!stamped) return false;
  const keys = selected.manifest.flatMap((member) => {
    const key = live.audioSourceKeyByShot.get(member.shotId);
    return key ? key.split('\n') : [];
  });
  // Source keys canonicalize the conversation order. Compare the same
  // multiset here, including duplicate lines, without changing stored rows.
  return (
    JSON.stringify(stamped.split('\n').sort()) === JSON.stringify(keys.sort())
  );
}

/**
 * The clip a render was sent is a pointer, like the frame version: a generated
 * dialogue clip's id is its `shot_dialogue_sections.id`, so picking another
 * reading of the same lines re-stales the clip even though the key (lines +
 * voices) did not move. Compared as SETS against the shot's own working set,
 * so a neighbour re-recording never reaches this shot. An entry with no clip
 * ids is not compared — a voice appearing is `audioSourceKey`'s job — and an
 * absent field is a very old row: unknown, never stale.
 */
function audioClipsMoved(
  entry: { shotId: string; audioClipIds?: readonly string[] },
  live: LiveShotInputs
): boolean {
  if (!entry.audioClipIds || entry.audioClipIds.length === 0) return false;
  const current = new Set(live.audioClipIdsByShot.get(entry.shotId) ?? []);
  const rendered = new Set(entry.audioClipIds);
  return (
    rendered.size !== current.size ||
    [...rendered].some((id) => !current.has(id))
  );
}

/**
 * Single-shot durations are snapped to the model's grid and may be raised
 * to cover dialogue audio. Packed members instead store their exact editorial
 * duration; only the whole clip is snapped. Unset durations are not compared.
 */
function durationMoved(
  entry: { shotId: string; durationMs?: number },
  model: string,
  live: LiveShotInputs,
  packed: boolean
): boolean {
  if (entry.durationMs === undefined) return false;
  const rawMs = live.durationMsByShot.get(entry.shotId);
  if (!rawMs || rawMs <= 0 || !isValidImageToVideoModel(model)) return false;
  // Packed entries store each member's editorial duration, not a standalone
  // request duration. The model's minimum applies to the whole clip (#1720).
  if (packed) return entry.durationMs !== Math.round(rawMs);
  const snapped = resolveShotDuration({ durationMs: rawMs, model });
  const audioSeconds = live.audioSecondsByShot.get(entry.shotId) ?? 0;
  const raised = raiseShotDurationToCoverAudio(snapped, audioSeconds, model);
  const candidates = new Set([
    Math.round(snapped * 1000),
    Math.round(raised * 1000),
  ]);
  return !candidates.has(entry.durationMs);
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
   * What each shot would render from now that its row does not hold:
   * dialogue key and reference provenance. See {@link LiveShotInputs}.
   */
  live: LoadedShotInputs;
}): SequenceSegment[] {
  // Membership lives on the shot; callers pass shots already in hierarchical
  // order (scene, then shot number).
  const orderedShots = input.shots;
  const shotIdsBySegment = new Map<string, string[]>();
  const currentMotionByShot = new Map<string, string | null>();
  const audioClipIdsByShot = new Map<string, readonly string[]>();
  const durationMsByShot = new Map<string, number | null>();
  const audioSecondsByShot = new Map<string, number>();
  for (const shot of orderedShots) {
    currentMotionByShot.set(shot.id, shot.selectedMotionPromptVersionId);
    const clips = shot.audioClips ?? [];
    audioClipIdsByShot.set(
      shot.id,
      clips.map((clip) => clip.id)
    );
    durationMsByShot.set(shot.id, shot.durationMs);
    audioSecondsByShot.set(
      shot.id,
      clips.reduce((sum, clip) => sum + (clip.durationSeconds ?? 0), 0)
    );
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

  const live: LiveShotInputs = {
    ...input.live,
    audioClipIdsByShot,
    durationMsByShot,
    audioSecondsByShot,
  };

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
        live
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
