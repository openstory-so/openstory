/**
 * "Update all" planning (#1077/#1085) — pure domain logic that decides *what*
 * regenerates (and therefore what gets billed). The workflow only freezes the
 * returned plan as a durable `step.do` result and orchestrates children.
 *
 * Depth vocabulary: `update-stale-depth.ts`. Staleness comparisons:
 * `shot-staleness.ts` (prompts/images) and segment assembly (video).
 *
 * Plan shape is deliberately ids + flags only — no `Scene` bodies — so a
 * sequence-scope run fits Cloudflare's 1 MiB step-result cap. Scenes are
 * materialised per shot at spawn time.
 */

import { musicPromptInputHashMatches } from '@/lib/ai/input-hash';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  DEFAULT_IMAGE_MODEL,
  safeTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { loadShotPromptContext } from '@/lib/ai/prompt-context';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Resolution } from '@/lib/constants/resolutions';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Sequence,
  Shot,
  StyleConfig,
} from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { assembleSequenceSegments } from '@/lib/scenes/scene-segments';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import {
  computeShotStaleness,
  type ShotStalenessRefs,
  type ShotStalenessResult,
} from '@/lib/shots/shot-staleness';
import {
  DEFAULT_UPDATE_STALE_DEPTH,
  depthIncludes,
  type UpdateStaleDepth,
} from '@/lib/shots/update-stale-depth';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { NotFoundError } from '@/lib/errors';
import type { MusicSceneSummary } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'shots', 'update-stale-plan']);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One shot's frozen slice of the plan. Holds only ids and flags — no `Scene`
 * objects (1 MiB step-result cap).
 */
export type PlanTarget = {
  shotId: string;
  frameId: string;
  /**
   * Neighbour shot ids for motion continuity, resolved to raw metadata at
   * spawn time (parity with regenerateShotPromptFn). Null when not a motion
   * target, or at the ends of the sequence.
   */
  beforeShotId: string | null;
  afterShotId: string | null;
  /** Frame image URL at plan time; image stage may produce a newer one later. */
  startingFrameImageUrl: string | null;
  /** Clip length, snapped to the model at render time. */
  durationMs: number | null;
  /**
   * The still and motion prompt the shot pointed at when the user clicked —
   * both selection pointers dereferenced ONCE, here. The video stage reads
   * these rows back by id (both tables are append-only) instead of following
   * the pointers, which a concurrent select can move mid-run. Ids rather than
   * rows: a full motion version (text + components + parameters + dialogue +
   * audio) per target is exactly the weight the plan cannot carry.
   *
   * The click pins the render: re-selecting a still or prompt after starting
   * Update all no longer changes what an in-flight run produces.
   */
  standingImageVariantId: string | null;
  standingMotionVersionId: string | null;
  /**
   * The visual prompt version selected at plan time — the one `imageLiveHash`
   * describes. A direct render (image stale, prompt fresh) reads THIS row back
   * by id rather than following the selection pointer, so the claim row's
   * advertised hash and the image actually billed describe the same prompt.
   * The id rather than the text because `frame_prompt_versions` is append-only:
   * the row cannot change under us, and a ULID is ~60× smaller on the payload.
   */
  visualPromptVersionId: string | null;
  regenVisual: boolean;
  regenMotion: boolean;
  /**
   * Re-render the still. Never true without an existing imageUrl — Update all
   * must not spend credits creating a first still.
   */
  regenImage: boolean;
  /**
   * Live input hashes at plan time — stamped onto pending claim rows so
   * in-flight work reads as 'updating' and duplicate enqueues no-op.
   */
  visualLiveHash: string | null;
  motionLiveHash: string | null;
  imageLiveHash: string | null;
  /** Model stamped on the image claim row AND rendered with. */
  imageModel: TextToImageModel;
  /**
   * Re-render this shot's video. True only when a video is already selected
   * (never a FIRST render), none is currently generating, and either an
   * upstream artifact regenerates in this run or the segment already reads
   * stale. Video/music use status columns rather than pending-claim rows.
   */
  regenVideo: boolean;
};

/**
 * Pending rows claimed for one shot. A null slot for a set regen flag means
 * either that artifact was not requested, or another run already holds a live
 * claim for it (this run skips only that artifact; other non-null slots still
 * regenerate).
 */
export type ShotClaims = {
  visualVersionId: string | null;
  motionVersionId: string | null;
  imageVariantId: string | null;
};

/**
 * Shots reported as incomplete work. Distinct from run failures:
 * - no-anchor / no-scene / staleness-unknown: nothing planned for the shot.
 * - already-in-flight: another run holds every live claim this run needed;
 *   this run owns no claims for the shot. (If some artifacts were claimed
 *   successfully and others were foreign, the shot is NOT listed here — the
 *   run regenerates the ones it owns.)
 */
export type SkippedShot = {
  shotId: string;
  reason:
    | 'no-anchor-frame'
    | 'no-scene'
    | 'staleness-unknown'
    | 'already-in-flight';
};

/**
 * Sequence-level music slice (depth 'music').
 * - `regenPrompt` — stored music-prompt hash diverges from live.
 * - `regenTrack` — track already exists AND the prompt regenerates (cascade
 *   only; no track-level staleness signal today). Never a FIRST generation.
 *
 * Music is always sequence-scoped, even when shot/scene narrows shot targets.
 *
 * The remaining fields ARE the music children's inputs, frozen here: the
 * regen decision is made by hashing exactly these summaries, so deriving them
 * a second time mid-run could spawn a child with inputs the plan never
 * evaluated. Inert (empty/default) whenever both flags are false.
 */
export type MusicPlan = {
  regenPrompt: boolean;
  regenTrack: boolean;
  sceneSummaries: MusicSceneSummary[];
  analysisModelId: AnalysisModelId;
  /** Provenance of the version the prompt child will write. */
  promptSource: 'ai-generated' | 'regenerated';
  /** Track length: shot durations with the 30s empty floor (generateMusicFn). */
  durationSeconds: number;
};

/**
 * The sequence fields every stage of the run needs, read once in `computePlan`
 * — the same read the plan's staleness decisions come from. Re-reading the row
 * per stage let a mid-run model/aspect-ratio change render something the plan
 * never priced.
 */
type PlanSequence = {
  id: string;
  teamId: string;
  title: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  imageModel: string;
  videoModel: string;
  styleId: string | null;
  analysisModel: string;
};

type PlanPromptContext = {
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
  styleConfig: StyleConfig;
  analysisModelId: AnalysisModelId;
};

export type UpdateStalePlan = {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  sequence: PlanSequence;
  /** Non-null only at depth 'music'. */
  music: MusicPlan | null;
  promptContext: PlanPromptContext | null;
  targets: PlanTarget[];
  skipped: SkippedShot[];
};

function toPlanSequence(sequence: Sequence): PlanSequence {
  return {
    id: sequence.id,
    teamId: sequence.teamId,
    title: sequence.title,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    imageModel: sequence.imageModel,
    videoModel: sequence.videoModel,
    styleId: sequence.styleId,
    analysisModel: sequence.analysisModel,
  };
}

// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------

/**
 * Recompute staleness for the in-scope shots from live state and freeze the
 * regeneration plan. The workflow persists this as the `compute-plan` step
 * result — the run's durable snapshot of what will be billed.
 */
export async function computePlan(args: {
  scopedDb: ScopedDb;
  sequenceId: string;
  sceneId?: string;
  shotId?: string;
  depth?: UpdateStaleDepth;
}): Promise<UpdateStalePlan> {
  const {
    scopedDb,
    sequenceId,
    sceneId,
    shotId,
    depth = DEFAULT_UPDATE_STALE_DEPTH,
  } = args;

  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) {
    // Trigger-side (computePlan runs in the server fn): OpenStoryError rides
    // the serialization adapter to the client as a typed 404, not a 500.
    throw new NotFoundError(`Sequence ${sequenceId} not found`);
  }

  const allShots = await scopedDb.shots.listBySequence(sequenceId);
  const inScope = filterInScopeShots(allShots, { sceneId, shotId });
  const shotIndexById = buildShotIndex(allShots);

  // Music is always sequence-scoped (not narrowed by scene/shot).
  const music = depthIncludes(depth, 'music')
    ? await computeMusicPlan(scopedDb, sequence, allShots)
    : null;

  const empty: UpdateStalePlan = {
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    sequence: toPlanSequence(sequence),
    music,
    promptContext: null,
    targets: [],
    skipped: [],
  };
  if (inScope.length === 0) return empty;

  const videoStateByShot = depthIncludes(depth, 'video')
    ? await loadVideoStateByShot(scopedDb, sequenceId, allShots)
    : new Map<string, ShotVideoState>();

  await scopedDb.shots.ensureAnchorFrames(inScope);
  const [anchorRows, scriptBySceneId, characters, locations, elements, style] =
    await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequenceId),
      loadSceneContextBySequence(scopedDb, sequenceId),
      scopedDb.characters.listWithSheets(sequenceId),
      scopedDb.sequenceLocations.listWithReferences(sequenceId),
      scopedDb.sequenceElements.list(sequenceId),
      sequence.styleId
        ? scopedDb.styles.getById(sequence.styleId)
        : Promise.resolve(null),
    ]);
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  // Stills live on the selected `frame_variants` rows (#1067) — one batch read
  // so the per-shot loop below stays query-free on the image surface.
  const frameIds = anchorRows.map((f) => f.id);
  const [selectedByFrame, selectedPromptByFrame, selectedMotionByShot] =
    await Promise.all([
      scopedDb.frameVariants.getSelectedByFrameIds(frameIds),
      scopedDb.framePromptVersions.getSelectedByFrameIds(frameIds),
      // Dereference the motion pointer HERE, once, so the video stage never
      // has to (see `PlanTarget.standingMotionVersionId`).
      scopedDb.shotPromptVersions.getSelectedMotionByShots(
        inScope.map((s) => s.id)
      ),
    ]);
  const refs: ShotStalenessRefs = { characters, locations, elements, style };

  const targets: PlanTarget[] = [];
  const skipped: SkippedShot[] = [];
  // Bibles are sequence-wide; any target scene is enough to load context.
  let sceneForBibles: Scene | null = null;

  for (const shot of inScope) {
    const frame = anchorsByShot.get(shot.id);
    const { scene } = resolveSceneForShot(shot, scriptBySceneId);

    const decision = await decideShotTarget({
      scopedDb,
      sequence,
      shot,
      frame,
      selectedImage: frame ? (selectedByFrame.get(frame.id) ?? null) : null,
      selectedPrompt: frame
        ? (selectedPromptByFrame.get(frame.id) ?? null)
        : null,
      selectedMotionVersionId: selectedMotionByShot.get(shot.id)?.id ?? null,
      scene,
      refs,
      depth,
      videoState: videoStateByShot.get(shot.id),
      shotIndexById,
      allShots,
    });

    if (decision.kind === 'skip') {
      skipped.push(decision.skip);
      continue;
    }
    if (decision.kind === 'noop') continue;

    targets.push(decision.target);
    sceneForBibles ??= scene;
  }

  if (targets.length === 0 || !sceneForBibles) {
    return { ...empty, skipped };
  }

  // Sequence-wide bibles + style — same loader as single-shot regen.
  const ctx = await loadShotPromptContext({
    scopedDb,
    sequence,
    scene: sceneForBibles,
  });

  return {
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    sequence: toPlanSequence(sequence),
    music,
    promptContext: {
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
    },
    targets,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Scope + video state
// ---------------------------------------------------------------------------

/** shotId wins over sceneId — a one-shot update never widens. */
function filterInScopeShots(
  allShots: Shot[],
  scope: { sceneId?: string; shotId?: string }
): Shot[] {
  const { sceneId, shotId } = scope;
  return allShots.filter((shot) => {
    if (shotId) return shot.id === shotId;
    if (sceneId) return shot.sceneId === sceneId;
    return true;
  });
}

function buildShotIndex(allShots: Shot[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < allShots.length; i++) {
    const shot = allShots[i];
    if (shot) index.set(shot.id, i);
  }
  return index;
}

type ShotVideoState = {
  hasVideo: boolean;
  alreadyStale: boolean;
  generating: boolean;
};

/**
 * Per-shot video state from segment assembly — the same batched reads + pure
 * assemble the UI's sequence-segments path uses, so "has a video" / "already
 * stale" / "currently generating" match the indicators.
 *
 * Video does not use prompt/image pending-claim rows; in-flight state lives
 * on `video_variants.status`.
 */
async function loadVideoStateByShot(
  scopedDb: ScopedDb,
  sequenceId: string,
  allShots: Shot[]
): Promise<Map<string, ShotVideoState>> {
  const [segments, versions, allFrames] = await Promise.all([
    scopedDb.renderSegments.listBySequence(sequenceId),
    scopedDb.videoVariants.listBySequence(sequenceId),
    scopedDb.frames.listBySequence(sequenceId),
  ]);
  const assembled = assembleSequenceSegments({
    segments,
    versions,
    shots: allShots,
    frames: allFrames,
  });

  const byShot = new Map<string, ShotVideoState>();
  for (const segment of assembled) {
    const generating = versions.some(
      (v) => v.renderSegmentId === segment.id && v.status === 'generating'
    );
    for (const segShotId of segment.shotIds) {
      byShot.set(segShotId, {
        hasVideo: segment.selectedVersion !== null,
        alreadyStale: segment.stale,
        generating,
      });
    }
  }
  return byShot;
}

// ---------------------------------------------------------------------------
// Per-shot decision
// ---------------------------------------------------------------------------

type ShotDecision =
  | { kind: 'target'; target: PlanTarget }
  | { kind: 'skip'; skip: SkippedShot }
  | { kind: 'noop' };

async function decideShotTarget(args: {
  scopedDb: ScopedDb;
  sequence: Sequence;
  shot: Shot;
  frame: Frame | undefined;
  /** Selected `frame_variants` row — the still's url/model/hash (#1067). */
  selectedImage: FrameVariant | null;
  /** Selected `frame_prompt_versions` row — the visual prompt a direct
   * image render will be built from. */
  selectedPrompt: FramePromptVersion | null;
  /** Selected motion prompt version id — the video-only-regen default. */
  selectedMotionVersionId: string | null;
  scene: Scene | null;
  refs: ShotStalenessRefs;
  depth: UpdateStaleDepth;
  videoState: ShotVideoState | undefined;
  shotIndexById: Map<string, number>;
  allShots: Shot[];
}): Promise<ShotDecision> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    selectedImage,
    selectedPrompt,
    selectedMotionVersionId,
    scene,
    refs,
    depth,
    videoState,
    shotIndexById,
    allShots,
  } = args;

  if (!frame) {
    return {
      kind: 'skip',
      skip: { shotId: shot.id, reason: 'no-anchor-frame' },
    };
  }
  if (!scene) {
    // Client staleness can still mark these stale (thumbnail without scene);
    // record the skip so the UI does not wait forever on unplanned work.
    return { kind: 'skip', skip: { shotId: shot.id, reason: 'no-scene' } };
  }

  const staleness = await computeShotStaleness({
    scopedDb,
    sequence,
    shot,
    frame,
    selectedImage,
    scene,
    refs,
  });

  // Fail closed: unknown ≠ fresh. Regenerating on a guess burns credits;
  // silent skip looks like a clean run.
  if (hasUnknownStaleness(staleness)) {
    return {
      kind: 'skip',
      skip: { shotId: shot.id, reason: 'staleness-unknown' },
    };
  }

  const flags = cascadeFlags({ staleness, selectedImage, depth, videoState });
  if (
    !flags.regenVisual &&
    !flags.regenMotion &&
    !flags.regenImage &&
    !flags.regenVideo
  ) {
    return { kind: 'noop' };
  }

  const idx = shotIndexById.get(shot.id) ?? -1;
  return {
    kind: 'target',
    target: {
      shotId: shot.id,
      frameId: frame.id,
      beforeShotId:
        flags.regenMotion && idx > 0 ? (allShots[idx - 1]?.id ?? null) : null,
      afterShotId:
        flags.regenMotion && idx >= 0 ? (allShots[idx + 1]?.id ?? null) : null,
      startingFrameImageUrl: selectedImage?.url ?? null,
      durationMs: shot.durationMs,
      standingImageVariantId: selectedImage?.id ?? null,
      standingMotionVersionId: selectedMotionVersionId,
      visualPromptVersionId: selectedPrompt?.id ?? null,
      regenVisual: flags.regenVisual,
      regenMotion: flags.regenMotion,
      regenImage: flags.regenImage,
      visualLiveHash: staleness.liveHashes.visualPrompt,
      motionLiveHash: staleness.liveHashes.motionPrompt,
      imageLiveHash: staleness.liveHashes.thumbnail,
      imageModel: safeTextToImageModel(
        selectedImage?.model,
        DEFAULT_IMAGE_MODEL
      ),
      regenVideo: flags.regenVideo,
    },
  };
}

function hasUnknownStaleness(staleness: ShotStalenessResult): boolean {
  return (
    staleness.thumbnail === 'unknown' ||
    staleness.visualPrompt === 'unknown' ||
    staleness.motionPrompt === 'unknown'
  );
}

/**
 * Cascade boolean algebra for one shot. Depth is cumulative
 * (`depthIncludes`). Never first-creates a still or video.
 *
 * - prompts/images: hash + pending-claim vocabulary from `computeShotStaleness`
 *   (`'stale'` only; `'updating'` is already covered).
 * - video: segment assembly status columns (no pending-claim rows yet).
 */
function cascadeFlags(args: {
  staleness: ShotStalenessResult;
  selectedImage: Pick<FrameVariant, 'url'> | null;
  depth: UpdateStaleDepth;
  videoState: ShotVideoState | undefined;
}): {
  regenVisual: boolean;
  regenMotion: boolean;
  regenImage: boolean;
  regenVideo: boolean;
} {
  const { staleness, selectedImage, depth, videoState } = args;

  // 'stale' only — 'updating' is a live claim already fixing this artifact.
  const regenVisual = staleness.visualPrompt === 'stale';
  const regenMotion = staleness.motionPrompt === 'stale';

  // Depth ≥ images: re-render stills that are stale, or whose visual prompt
  // regenerates in this run (would read stale the moment the prompt lands).
  // Depth 'prompts' renders nothing. Never a FIRST still.
  const regenImage =
    depthIncludes(depth, 'images') &&
    !!selectedImage?.url &&
    (staleness.thumbnail === 'stale' || regenVisual);

  // Depth ≥ video: existing videos whose upstream changes in this run, or
  // whose manifest already diverged. Leave in-flight renders alone.
  const regenVideo =
    !!videoState &&
    videoState.hasVideo &&
    !videoState.generating &&
    (regenMotion || regenImage || videoState.alreadyStale);

  return { regenVisual, regenMotion, regenImage, regenVideo };
}

// ---------------------------------------------------------------------------
// Music plan
// ---------------------------------------------------------------------------

/**
 * Sequence-level music slice. Mirrors `getMusicPromptStalenessFn`'s comparison
 * (latest version's analysis model, fallback to the sequence's). Untracked
 * (no stored hash / no scenes) means nothing — never a first music prompt or
 * track. In-flight generation is left to finish.
 */
/** Same rule as `generateMusicFn`: shot durations, 10s each when unset, with
 * a 30s floor for an empty sequence. */
function musicDurationSeconds(allShots: Shot[]): number {
  return (
    Math.round(
      allShots.reduce(
        (sum, s) => sum + (s.durationMs ? s.durationMs / 1000 : 10),
        0
      )
    ) || 30
  );
}

async function computeMusicPlan(
  scopedDb: ScopedDb,
  sequence: Sequence,
  allShots: Shot[]
): Promise<MusicPlan> {
  // The child model the prompt regen would run with — the sequence's, matching
  // the manual regenerate path. The staleness comparison below instead honours
  // a model pinned by the latest stored version, mirroring
  // `getMusicPromptStalenessFn`.
  const analysisModelId =
    getAnalysisModelById(sequence.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL;
  const none: MusicPlan = {
    regenPrompt: false,
    regenTrack: false,
    sceneSummaries: [],
    analysisModelId,
    promptSource: 'ai-generated',
    durationSeconds: 30,
  };
  if (!sequence.musicPromptInputHash) return none;

  const sceneContext = await loadSceneContextBySequence(scopedDb, sequence.id);
  const scenes = allShots
    .map((s) => resolveSceneForShot(s, sceneContext).scene)
    .filter((s): s is NonNullable<typeof s> => s !== null);
  if (scenes.length === 0) return none;

  try {
    const sceneSummaries = buildMusicSceneSummaries(scenes);
    const latest = await scopedDb.sequenceMusicPromptVersions.getLatest(
      sequence.id
    );
    const analysisModel = latest?.analysisModel ?? analysisModelId;
    const regenPrompt = !(await musicPromptInputHashMatches(
      sequence.musicPromptInputHash,
      { sceneSummaries, analysisModel }
    ));
    return {
      regenPrompt,
      // Cascade-only: track follows its prompt. No track-level staleness today.
      regenTrack:
        regenPrompt &&
        !!sequence.musicUrl &&
        sequence.musicStatus !== 'generating',
      sceneSummaries,
      analysisModelId,
      promptSource: latest ? 'regenerated' : 'ai-generated',
      durationSeconds: musicDurationSeconds(allShots),
    };
  } catch (error) {
    // Fail closed — same posture as per-shot 'unknown'.
    logger.warn(`music staleness uncomputable for sequence ${sequence.id}:`, {
      err: error,
    });
    return none;
  }
}

// ---------------------------------------------------------------------------
// claimTargets
// ---------------------------------------------------------------------------

/**
 * Pre-create a pending version row per prompt/image artifact this run will
 * produce, so in-flight work reads as 'updating', duplicate enqueues no-op,
 * and children complete these rows in place.
 *
 * Idempotent across step retries: a live claim stamped with THIS run's
 * instance id is reused; one stamped by anyone else → `already-in-flight`.
 * Video/music have no claim rows (status columns instead).
 */
export async function claimTargets(args: {
  scopedDb: ScopedDb;
  targets: PlanTarget[];
  sequenceId: string;
  parentInstanceId: string;
}): Promise<{
  claimsByShot: Record<string, ShotClaims>;
  skipped: SkippedShot[];
}> {
  const { scopedDb, targets, sequenceId, parentInstanceId } = args;
  const claimsByShot: Record<string, ShotClaims> = {};
  const skipped: SkippedShot[] = [];

  for (const target of targets) {
    const { claims, foreignClaim } = await claimShotArtifacts({
      scopedDb,
      target,
      sequenceId,
      parentInstanceId,
    });
    // Only report already-in-flight when this run owns nothing for the shot.
    // Partial ownership (e.g. visual ours, motion foreign) still regenerates
    // the owned artifacts and must not read as "nothing attempted".
    const ownsAny =
      claims.visualVersionId !== null ||
      claims.motionVersionId !== null ||
      claims.imageVariantId !== null;
    if (foreignClaim && !ownsAny) {
      skipped.push({ shotId: target.shotId, reason: 'already-in-flight' });
    }
    claimsByShot[target.shotId] = claims;
  }

  return { claimsByShot, skipped };
}

async function claimShotArtifacts(args: {
  scopedDb: ScopedDb;
  target: PlanTarget;
  sequenceId: string;
  parentInstanceId: string;
}): Promise<{ claims: ShotClaims; foreignClaim: boolean }> {
  const { scopedDb, target, sequenceId, parentInstanceId } = args;
  const claims: ShotClaims = {
    visualVersionId: null,
    motionVersionId: null,
    imageVariantId: null,
  };
  let foreignClaim = false;

  if (target.regenVisual && target.visualLiveHash) {
    const visualLiveHash = target.visualLiveHash;
    const result = await claimOrReuse({
      parentInstanceId,
      getExisting: () =>
        scopedDb.framePromptVersions.getLivePending(
          target.frameId,
          visualLiveHash
        ),
      create: () =>
        scopedDb.framePromptVersions.createPending({
          frameId: target.frameId,
          pendingInputHash: visualLiveHash,
          workflowRunId: parentInstanceId,
        }),
    });
    if (result.kind === 'ours') claims.visualVersionId = result.id;
    else foreignClaim = true;
  }

  if (target.regenMotion && target.motionLiveHash) {
    const motionLiveHash = target.motionLiveHash;
    const result = await claimOrReuse({
      parentInstanceId,
      getExisting: () =>
        scopedDb.shotPromptVersions.getLivePending(
          target.shotId,
          motionLiveHash
        ),
      create: () =>
        scopedDb.shotPromptVersions.createPending({
          shotId: target.shotId,
          pendingInputHash: motionLiveHash,
          workflowRunId: parentInstanceId,
        }),
    });
    if (result.kind === 'ours') claims.motionVersionId = result.id;
    else foreignClaim = true;
  }

  if (target.regenImage) {
    const imageResult = await claimImageArtifact({
      scopedDb,
      target,
      sequenceId,
      parentInstanceId,
      visualVersionId: claims.visualVersionId,
    });
    if (imageResult.kind === 'ours') {
      claims.imageVariantId = imageResult.id;
    } else if (imageResult.kind === 'foreign') {
      foreignClaim = true;
    }
  }

  return { claims, foreignClaim };
}

type ClaimResult = { kind: 'ours'; id: string } | { kind: 'foreign' };

/**
 * Reuse our own live claim (step retry), treat anyone else's as foreign, or
 * create a new pending row. Lost insert races (partial unique index) → foreign
 * only when a live claim actually exists; other insert failures rethrow.
 */
async function claimOrReuse(args: {
  parentInstanceId: string;
  getExisting: () => Promise<{
    id: string;
    workflowRunId: string | null;
  } | null>;
  create: () => Promise<{ id: string }>;
}): Promise<ClaimResult> {
  const existing = await args.getExisting();
  if (existing) {
    return existing.workflowRunId === args.parentInstanceId
      ? { kind: 'ours', id: existing.id }
      : { kind: 'foreign' };
  }
  try {
    const row = await args.create();
    return { kind: 'ours', id: row.id };
  } catch (error) {
    // Lost the insert race to a concurrent enqueue — only if a live claim
    // is actually there. D1 blips / other constraint errors must surface.
    const raced = await args.getExisting();
    if (raced) {
      return raced.workflowRunId === args.parentInstanceId
        ? { kind: 'ours', id: raced.id }
        : { kind: 'foreign' };
    }
    throw error;
  }
}

async function claimImageArtifact(args: {
  scopedDb: ScopedDb;
  target: PlanTarget;
  sequenceId: string;
  parentInstanceId: string;
  visualVersionId: string | null;
}): Promise<ClaimResult | { kind: 'none' }> {
  const { scopedDb, target, sequenceId, parentInstanceId, visualVersionId } =
    args;
  const liveClaims = await scopedDb.frameVariants.listLiveClaims(
    target.frameId
  );

  if (target.regenVisual) {
    // Chained render: only valid behind OUR visual claim. A foreign visual
    // claim means someone else owns the prompt regen — do not chain onto it.
    if (!visualVersionId) return { kind: 'foreign' };

    const ours = liveClaims.find(
      (c) => c.dependsOnVersionId === visualVersionId
    );
    if (ours) return { kind: 'ours', id: ours.id };

    const row = await scopedDb.frameVariants.createPendingClaim({
      frameId: target.frameId,
      sequenceId,
      model: target.imageModel,
      dependsOnVersionId: visualVersionId,
      workflowRunId: parentInstanceId,
    });
    return { kind: 'ours', id: row.id };
  }

  if (!target.imageLiveHash) return { kind: 'none' };

  const existing = liveClaims.find(
    (c) => c.pendingInputHash === target.imageLiveHash
  );
  if (existing) {
    return existing.workflowRunId === parentInstanceId
      ? { kind: 'ours', id: existing.id }
      : { kind: 'foreign' };
  }

  try {
    const row = await scopedDb.frameVariants.createPendingClaim({
      frameId: target.frameId,
      sequenceId,
      model: target.imageModel,
      pendingInputHash: target.imageLiveHash,
      workflowRunId: parentInstanceId,
    });
    return { kind: 'ours', id: row.id };
  } catch (error) {
    // Re-list live claims: unique-index race → foreign/ours; other errors rethrow.
    const after = await scopedDb.frameVariants.listLiveClaims(target.frameId);
    const raced = after.find(
      (c) => c.pendingInputHash === target.imageLiveHash
    );
    if (raced) {
      return raced.workflowRunId === parentInstanceId
        ? { kind: 'ours', id: raced.id }
        : { kind: 'foreign' };
    }
    throw error;
  }
}
