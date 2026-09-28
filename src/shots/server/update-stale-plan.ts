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

import {
  usesStartFrame,
  type StartFrameSequence,
} from '@/shots/use-start-frame';
import { musicPromptInputHashMatches } from '@/shots/input-hash';
import {
  musicRequestDurationSeconds,
  readMusicTrackStaleness,
} from '@/audio/server/music-staleness';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
  type AnalysisModelId,
} from '@/models/models.config';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
  type TextToImageModel,
} from '@/models/models';
import { loadShotPromptContext } from './prompt-context';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  MotionDialogue,
  Scene,
} from '@/shots/scene-analysis.schema';
import {
  dialogueContextFor,
  sceneDialogueJobs,
  shotPromptDialogueResolver,
  type ShotDialogueResolver,
  type ShotPromptDialogue,
} from './shot-dialogue';
import {
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  matchingDialogueClips,
  voicedDialogueLines,
  type VoiceCharacter,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { BatchDialogueRecording } from '@/platform/server/workflow/types';
import type { SceneVoicedLine } from '@/shots/shot-dialogue';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Sequence,
  Shot,
  StyleConfig,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import { loadSequenceSegments } from '@/shots/server/sequence-segments';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from './scene-script';
import {
  computeShotStaleness,
  type ShotStalenessRefs,
  type ShotStalenessResult,
} from './shot-staleness';
import {
  DEFAULT_UPDATE_STALE_DEPTH,
  depthIncludes,
  type UpdateStaleDepth,
} from '@/shots/update-stale-depth';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';
import { NotFoundError } from '@/platform/errors';
import type { PlanUnitKind, PlanUnitRef } from '@/sequences/generation-plan';
import { resolveSceneShotImageReferences } from '@/cast/server/workflows/sheet-snapshots';
import { buildRegenerateShotSnapshot } from '@/shots/server/workflows/regenerate-shots-snapshot';
import { pendingVoiceId } from './pending-voices';
import {
  buildPlanReferences,
  type PlanReferences,
} from './update-stale-references';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';

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
  /**
   * Does THIS shot animate from its still? Snapshotted per target rather than
   * read off `plan.sequence`, because a shot can override the sequence
   * (`shots.useStartFrame`). Frozen at click time like every other pointer
   * here — a mid-run toggle must not send half the run down each route.
   */
  usesStartFrame: boolean;
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
  /**
   * A continue (#1818) renders the shot's FIRST video too; Update all never
   * does, so the render stands down when the selection is gone.
   */
  createsVideo: boolean;
  /**
   * The clip's selected version at the click, when `regenVideo` judged it
   * stale. While it is still the selection the run renders, whatever made
   * it stale (a sheet, a recording, the prompt); a different selection means
   * someone rendered since, and the manifest check decides.
   */
  staleVideoVersionId: string | null;
  /**
   * The sheet / element rows the still (or reference-only clip) is made
   * from. A references-wave unit of this run that fails holds the shot's
   * image and video rather than render without it.
   */
  referenceIds: string[];
  /**
   * The shot's scene has other live shots. Its clip renders on its own, so
   * it carries the scene header (location, time, lighting, palette, look) a
   * packed clip states once — the same rule the fresh run and the batch
   * footer apply.
   */
  attachSceneHeader: boolean;
  /**
   * Re-record this shot's dialogue audio. True only when a reading already
   * exists (never a FIRST recording) and no longer matches the current
   * lines or voice. Independent of `regenVideo` so a take can be reviewed
   * before the clip is re-rendered (#1703).
   */
  regenDialogue: boolean;
  /**
   * The lines this shot speaks, from the shot dialogue node at click time
   * (#1657). Snapshotted here because the node is mutable and the run
   * renders minutes later: the clip's bound audio, and the TTS the video
   * stage bills when no clip matches, both come from these words. Resolved
   * by `shotDialogueResolver`, the same answer every trigger uses.
   */
  dialogue: MotionDialogue;
  /**
   * The conversation around the shot at click time, for a video stage that
   * finds no matching clip and has to record one in context. Empty when the
   * shot voices nothing. The run cannot read its neighbours' lines.
   */
  dialogueContext: SceneVoicedLine[];
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
 * - `regenTrack` — the track's own `sequence_music_variants.inputHash`
 *   diverges from the live prompt / tags / durations (#1657), OR the prompt
 *   regenerates and cascades into it. Never a FIRST generation.
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
  /**
   * Reference-only mode, pinned with the rest of the plan: an update-stale run
   * regenerates prompts, and the mode selects which motion-prompt template
   * writes them. Re-reading it per stage would let a mid-run toggle produce a
   * sequence with half its prompts in each style.
   */
  generateStartFrames: boolean;
  /** Render motion as Ark drafts (#1756); pinned like the rest. */
  draftMotion: boolean;
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
  /**
   * Speakers with a designed voice at click time (#1554). Snapshotted so the
   * motion *render* (TTS) never re-reads `characters.voiceId`. Not a prompt
   * hash channel — voice identity binds on the clip.
   */
  characterVoices: {
    name: string;
    voiceId: string;
    voiceOnly: boolean;
  }[];
  /**
   * Scenes to record ONCE before any video renders (#1657): every scene with
   * a voiced target whose video is being re-rendered. The recorder checks the
   * live clips itself, so a scene whose audio still matches costs nothing.
   * Null when no target speaks.
   */
  dialogueRecording: BatchDialogueRecording | null;
  targets: PlanTarget[];
  skipped: SkippedShot[];
  /**
   * Sheets, element references and voices to make before any shot (#1818).
   * Null for Update all, which never touches them yet.
   */
  references: PlanReferences | null;
};

/**
 * The first target whose `usesStartFrame` did not survive the payload round
 * trip, or `null` when the plan is intact.
 *
 * `usesStartFrame` is typed required, but a plan frozen by a build that
 * predates it replays out of the durable payload without the key — and
 * `!undefined` is `true`, which every read site takes to mean "render this
 * shot reference-only". That failure is silent AND expensive: on a model with
 * a reference-to-video route the run SUCCEEDS, rewriting every motion prompt
 * with the reference-only template and re-rendering every clip with no start
 * frame, billed, with nothing in the logs.
 *
 * So the value is demanded rather than defaulted. Inferring `!referenceOnly`
 * here would be a guess about a shot that may have overridden the sequence,
 * and a wrong guess spends money; a rejected run costs one click.
 */
export function findTargetMissingStartFrameMode(
  plan: Pick<UpdateStalePlan, 'targets'>
): PlanTarget | null {
  return (
    plan.targets.find((target) => typeof target.usesStartFrame !== 'boolean') ??
    null
  );
}

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
    generateStartFrames: sequence.generateStartFrames,
    draftMotion: sequence.draftMotion,
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
  /**
   * A continue (#1818): exactly these generation-plan units, first ones
   * included — the flags come from the units, not from the staleness
   * cascade, and the "never a FIRST still / video / recording" guards are
   * Update all's, not the plan's. Scope and depth are ignored.
   */
  units?: readonly PlanUnitRef[];
  /** Who clicked — stamped on the references wave's payloads. */
  userId?: string;
}): Promise<UpdateStalePlan> {
  const {
    scopedDb,
    sequenceId,
    sceneId,
    shotId,
    depth = DEFAULT_UPDATE_STALE_DEPTH,
    units,
  } = args;

  const sequence = await scopedDb.sequences.getById(sequenceId);
  if (!sequence) {
    // Trigger-side (computePlan runs in the server fn): OpenStoryError rides
    // the serialization adapter to the client as a typed 404, not a 500.
    throw new NotFoundError(`Sequence ${sequenceId} not found`);
  }

  const allShots = await scopedDb.shots.listBySequence(sequenceId);
  const unitKindsByShot = new Map<string, Set<PlanUnitKind>>();
  for (const unit of units ?? []) {
    const kinds = unitKindsByShot.get(unit.id) ?? new Set<PlanUnitKind>();
    kinds.add(unit.kind);
    unitKindsByShot.set(unit.id, kinds);
  }
  const inScope = units
    ? allShots.filter((shot) => unitKindsByShot.has(shot.id))
    : filterInScopeShots(allShots, { sceneId, shotId });
  const shotIndexById = buildShotIndex(allShots);

  // Music is always sequence-scoped (not narrowed by scene/shot).
  const music = units
    ? await computeMusicPlanForUnits(scopedDb, sequence, allShots, units)
    : depthIncludes(depth, 'music')
      ? await computeMusicPlan(scopedDb, sequence, allShots)
      : null;
  const references =
    units && args.userId
      ? await buildPlanReferences({
          scopedDb,
          sequence,
          userId: args.userId,
          units,
        })
      : null;

  const empty: UpdateStalePlan = {
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    sequence: toPlanSequence(sequence),
    music,
    promptContext: null,
    characterVoices: [],
    dialogueRecording: null,
    targets: [],
    skipped: [],
    references,
  };
  if (inScope.length === 0) return empty;

  const videoStateByShot = (
    units ? units.some((u) => u.kind === 'clip') : depthIncludes(depth, 'video')
  )
    ? await loadVideoStateByShot(scopedDb, sequenceId, allShots, sequence)
    : new Map<string, ShotVideoState>();

  await scopedDb.shots.ensureAnchorFrames(inScope);
  const [
    anchorRows,
    scriptBySceneId,
    characters,
    locations,
    elements,
    style,
    voiceRows,
  ] = await Promise.all([
    scopedDb.frames.listAnchorsBySequence(sequenceId),
    loadSceneContextBySequence(scopedDb, sequenceId),
    scopedDb.characters.listWithSheets(sequenceId),
    scopedDb.sequenceLocations.listWithReferences(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
    sequence.styleId
      ? scopedDb.styles.getById(sequence.styleId)
      : Promise.resolve(null),
    scopedDb.characters.list(sequenceId),
  ]);
  // A voice this run designs (#1818) speaks under a placeholder until the
  // references wave lands it — `bindPendingVoices`.
  const owedVoiceIds = new Set(references?.voices.map((v) => v.characterDbId));
  const characterVoices = voiceRows.flatMap((row) => {
    const voiceId = owedVoiceIds.has(row.id)
      ? pendingVoiceId(row.id)
      : row.voiceId;
    return voiceId
      ? [{ name: row.name, voiceId, voiceOnly: row.voiceOnly }]
      : [];
  });
  const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
  // Stills live on the selected `frame_variants` rows (#1067) — one batch read
  // so the per-shot loop below stays query-free on the image surface.
  const frameIds = anchorRows.map((f) => f.id);
  const [
    selectedByFrame,
    selectedPromptByFrame,
    selectedMotionByShot,
    dialogueVersions,
  ] = await Promise.all([
    scopedDb.frameVariants.getSelectedByFrameIds(frameIds),
    scopedDb.framePromptVersions.getSelectedByFrameIds(frameIds),
    // Dereference the motion pointer HERE, once, so the video stage never
    // has to (see `PlanTarget.standingMotionVersionId`).
    // Every shot, not just the ones in scope: a neighbour's pre-#1657 lines
    // are part of the conversation a target is recorded in.
    scopedDb.shotPromptVersions.getSelectedMotionByShots(
      allShots.map((s) => s.id)
    ),
    // The authored dialogue per shot, read once (#1657). Each target carries
    // only its own shot's lines, so the run never reads the node mid-flight.
    // The rows, not just the lines: a recording names the version it spoke.
    scopedDb.shotDialogue.getSelectedBySequence(sequence.id),
  ]);
  const dialogueLinesByShotId = new Map(
    dialogueVersions.map((version) => [version.shotId, version.lines])
  );
  const refs: ShotStalenessRefs = { characters, locations, elements, style };
  const promptDialogueOf = shotPromptDialogueResolver({
    linesByShotId: dialogueLinesByShotId,
    shots: allShots,
    legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
    scriptDialogueOf: (sceneId) =>
      scriptBySceneId.get(sceneId)?.script?.dialogue,
  });
  const dialogueOf: ShotDialogueResolver = (shot) =>
    promptDialogueOf(shot).dialogue;

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
      dialogue: promptDialogueOf(shot),
      characterVoices,
      scene,
      refs,
      depth,
      videoState: videoStateByShot.get(shot.id),
      shotIndexById,
      allShots,
      unitKinds: units ? (unitKindsByShot.get(shot.id) ?? new Set()) : null,
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

  // Sequence-wide bibles + style — same loader as single-shot regen. Only
  // the bibles are read off this context, so the sequence default stands in
  // for the per-shot mode (which is frozen per target as `usesStartFrame`).
  const ctx = await loadShotPromptContext({
    scopedDb,
    sequence: { ...sequence, referenceOnly: !sequence.generateStartFrames },
    scene: sceneForBibles,
  });

  const shotById = new Map(allShots.map((shot) => [shot.id, shot]));
  for (const target of targets) {
    const sceneId = shotById.get(target.shotId)?.sceneId;
    target.dialogueContext =
      dialogueContextFor({
        shot: { id: target.shotId },
        voicedLines: voicedDialogueLines(target.dialogue, characterVoices),
        // Whether a clip still matches is decided mid-run, against the model
        // the render resolves; the context rides along either way.
        audioClips: [],
        sceneShots: allShots.filter(
          (shot) => sceneId && shot.sceneId === sceneId && !shot.deletedAt
        ),
        dialogueOf,
        characters: characterVoices,
      }) ?? [];
  }
  const dialogueScenes = sceneDialogueJobs({
    needing: targets
      .filter(
        (target) =>
          (target.regenDialogue || target.regenVideo) &&
          voicedDialogueLines(target.dialogue, characterVoices).length > 0
      )
      .map((target) => ({ id: target.shotId })),
    shots: allShots,
    dialogueOf,
    characters: characterVoices,
    versionIdByShotId: new Map(
      dialogueVersions.map((version) => [version.shotId, version.id])
    ),
    shotSecondsOf: (shotId) => {
      const durationMs = shotById.get(shotId)?.durationMs;
      return durationMs && durationMs > 0 ? durationMs / 1000 : undefined;
    },
  });
  // ponytail: bounds come from the sequence's video model; a target whose
  // selected version used a tighter model is still checked by its own render.
  const dialogueModels = [
    safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
  ];
  return {
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    sequence: toPlanSequence(sequence),
    music,
    characterVoices,
    dialogueRecording:
      dialogueScenes.length > 0
        ? {
            scenes: dialogueScenes,
            minDurationSeconds: dialogueAudioMinSeconds(dialogueModels),
            maxDurationSeconds: dialogueAudioMaxSeconds(dialogueModels),
          }
        : null,
    promptContext: {
      characterBible: [...ctx.characterBible],
      locationBible: [...ctx.locationBible],
      elementBible: [...ctx.elementBible],
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
    },
    targets,
    skipped,
    references,
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
  selectedVersionId: string | null;
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
  allShots: Shot[],
  sequence: StartFrameSequence
): Promise<Map<string, ShotVideoState>> {
  const { assembled, versions } = await loadSequenceSegments(
    scopedDb,
    { ...sequence, id: sequenceId },
    allShots
  );

  const byShot = new Map<string, ShotVideoState>();
  for (const segment of assembled) {
    const generating = versions.some(
      (v) => v.renderSegmentId === segment.id && v.status === 'generating'
    );
    for (const segShotId of segment.shotIds) {
      byShot.set(segShotId, {
        hasVideo: segment.selectedVersion !== null,
        selectedVersionId: segment.selectedVersion?.id ?? null,
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
  /**
   * What the shot says now (`PlanTarget.dialogue`), and whether it is on
   * its dialogue node — the motion prompt's staleness reads both (#1784).
   */
  dialogue: ShotPromptDialogue;
  characterVoices: VoiceCharacter[];
  scene: Scene | null;
  refs: ShotStalenessRefs;
  depth: UpdateStaleDepth;
  videoState: ShotVideoState | undefined;
  shotIndexById: Map<string, number>;
  allShots: Shot[];
  /** A continue's units for this shot (#1818); null for Update all. */
  unitKinds: ReadonlySet<PlanUnitKind> | null;
}): Promise<ShotDecision> {
  const {
    scopedDb,
    sequence,
    shot,
    frame,
    selectedImage,
    selectedPrompt,
    selectedMotionVersionId,
    dialogue: promptDialogue,
    characterVoices,
    scene,
    refs,
    depth,
    videoState,
    shotIndexById,
    allShots,
    unitKinds,
  } = args;
  const { dialogue } = promptDialogue;

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
    dialogue: promptDialogue,
  });

  // Fail closed: unknown ≠ fresh. Regenerating on a guess burns credits;
  // silent skip looks like a clean run.
  if (hasUnknownStaleness(staleness)) {
    return {
      kind: 'skip',
      skip: { shotId: shot.id, reason: 'staleness-unknown' },
    };
  }

  const shotUsesStartFrame = usesStartFrame(shot, sequence);
  const flags = unitKinds
    ? {
        regenVisual: unitKinds.has('prompt:visual'),
        regenMotion: unitKinds.has('prompt:motion'),
        regenImage: unitKinds.has('still'),
        regenDialogue: unitKinds.has('dialogue'),
        regenVideo: unitKinds.has('clip'),
      }
    : cascadeFlags({
        staleness,
        selectedImage,
        depth,
        videoState,
        usesStartFrame: shotUsesStartFrame,
        voicedLines: voicedDialogueLines(dialogue, characterVoices),
        audioClips: shot.audioClips,
      });
  if (
    !flags.regenVisual &&
    !flags.regenMotion &&
    !flags.regenImage &&
    !flags.regenDialogue &&
    !flags.regenVideo
  ) {
    return { kind: 'noop' };
  }

  // A first still has no stored model: it renders at the sequence's, and
  // the claim advertises the same one.
  const imageModel = safeTextToImageModel(
    selectedImage?.model ?? (unitKinds ? sequence.imageModel : undefined),
    DEFAULT_IMAGE_MODEL
  );
  // A first still behind a prompt this run keeps has no live hash yet (the
  // verdict only hashes a still that exists); the direct claim needs one.
  let imageLiveHash = staleness.liveHashes.thumbnail;
  if (
    flags.regenImage &&
    !flags.regenVisual &&
    !imageLiveHash &&
    selectedPrompt?.text
  ) {
    imageLiveHash = (
      await buildRegenerateShotSnapshot({
        shot,
        scene,
        frameId: frame.id,
        imagePrompt: selectedPrompt.text,
        characters: refs.characters,
        locations: refs.locations,
        elements: refs.elements,
        imageModel,
        aspectRatio: sequence.aspectRatio,
      })
    ).snapshotInputHash;
  }
  const referenceIds = unitKinds
    ? (() => {
        const matched = resolveSceneShotImageReferences({
          scene,
          visualPrompt: selectedPrompt?.text ?? null,
          characters: refs.characters,
          locations: refs.locations,
          elements: refs.elements,
        });
        return [
          ...matched.characters.map((c) => c.id),
          ...matched.locations.map((l) => l.id),
          ...matched.elements.map((e) => e.id),
        ];
      })()
    : [];

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
      usesStartFrame: usesStartFrame(shot, sequence),
      durationMs: shot.durationMs,
      standingImageVariantId: selectedImage?.id ?? null,
      standingMotionVersionId: selectedMotionVersionId,
      visualPromptVersionId: selectedPrompt?.id ?? null,
      regenVisual: flags.regenVisual,
      regenMotion: flags.regenMotion,
      regenImage: flags.regenImage,
      visualLiveHash: staleness.liveHashes.visualPrompt,
      motionLiveHash: staleness.liveHashes.motionPrompt,
      imageLiveHash,
      imageModel,
      regenVideo: flags.regenVideo,
      createsVideo: flags.regenVideo && !videoState?.hasVideo,
      staleVideoVersionId: flags.regenVideo
        ? (videoState?.selectedVersionId ?? null)
        : null,
      referenceIds,
      attachSceneHeader:
        !!shot.sceneId &&
        allShots.filter((row) => row.sceneId === shot.sceneId && !row.deletedAt)
          .length > 1,
      regenDialogue: flags.regenDialogue,
      dialogue,
      // Filled in by `computePlan` once the voices are loaded.
      dialogueContext: [],
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
 * - dialogue: existing clips whose source key no longer matches (#1703).
 * - video: segment assembly status columns (no pending-claim rows yet).
 */
function cascadeFlags(args: {
  staleness: ShotStalenessResult;
  selectedImage: Pick<FrameVariant, 'url'> | null;
  depth: UpdateStaleDepth;
  videoState: ShotVideoState | undefined;
  /** Resolved per shot — a reference-only clip never reads its still. */
  usesStartFrame: boolean;
  voicedLines: readonly VoicedDialogueLine[];
  audioClips: Shot['audioClips'];
}): {
  regenVisual: boolean;
  regenMotion: boolean;
  regenImage: boolean;
  regenDialogue: boolean;
  regenVideo: boolean;
} {
  const {
    staleness,
    selectedImage,
    depth,
    videoState,
    usesStartFrame,
    voicedLines,
    audioClips,
  } = args;

  // 'stale' only — 'updating' is a live claim already fixing this artifact.
  const regenVisual = staleness.visualPrompt === 'stale';
  const regenMotion = staleness.motionPrompt === 'stale';

  // Depth ≥ images: re-render stills that are stale, or whose visual prompt
  // regenerates in this run (would read stale the moment the prompt lands).
  // Depth 'prompts' renders nothing. Never a FIRST still. Never on a
  // reference-only shot: its clip renders from the sheets, so a re-rendered
  // still is billed and then ignored — and would cascade into the clip too.
  const regenImage =
    usesStartFrame &&
    depthIncludes(depth, 'images') &&
    !!selectedImage?.url &&
    (staleness.thumbnail === 'stale' || regenVisual);

  // Depth ≥ dialogue: existing audio whose clips no longer match the current
  // reading. Never a FIRST recording. Does not cascade into video — the new
  // take is meant to be reviewed first (#1703).
  const regenDialogue =
    depthIncludes(depth, 'dialogue') &&
    voicedLines.length > 0 &&
    (audioClips?.length ?? 0) > 0 &&
    matchingDialogueClips(audioClips, voicedLines).length === 0;

  // Depth ≥ video: existing videos whose upstream changes in this run, or
  // whose manifest already diverged. Leave in-flight renders alone.
  const regenVideo =
    depthIncludes(depth, 'video') &&
    !!videoState &&
    videoState.hasVideo &&
    !videoState.generating &&
    (regenMotion || regenImage || videoState.alreadyStale);

  return {
    regenVisual,
    regenMotion,
    regenImage,
    regenDialogue,
    regenVideo,
  };
}

// ---------------------------------------------------------------------------
// Music plan
// ---------------------------------------------------------------------------

/**
 * Sequence-level music slice. Mirrors `getMusicPromptStalenessFn`'s comparison
 * (latest version's analysis model, fallback to the sequence's) AND
 * `readMusicTrackStaleness`'s for the track. Untracked (no stored hash / no
 * scenes) means nothing — never a first music prompt or track. In-flight
 * generation is left to finish.
 */
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
  // Shared with the scene-music badge (`getMusicPromptStalenessFn`) so the
  // plan and the UI agree on the duration they hash.
  const durationSeconds = musicRequestDurationSeconds(allShots);
  // Track staleness stands on its own (#1657): a hand-edited prompt NULLs
  // `musicPromptInputHash`, so gating this behind the prompt's hash would hide
  // exactly the case the edit created. Never a first generation.
  const hasIdleTrack =
    !!sequence.musicUrl && sequence.musicStatus !== 'generating';
  const trackStale =
    hasIdleTrack &&
    (await readMusicTrackStaleness(scopedDb, sequence, allShots)) === 'stale';
  const none: MusicPlan = {
    regenPrompt: false,
    regenTrack: trackStale,
    sceneSummaries: [],
    analysisModelId,
    promptSource: 'ai-generated',
    durationSeconds,
  };
  if (!sequence.musicPromptInputHash) return none;

  // Outside the try, as before #1783: a failed read must fail the plan, not
  // quietly skip a music prompt that may be stale.
  const sceneRows = await scopedDb.scenes.listBySequence(sequence.id);
  try {
    const { sceneSummaries, legacyShotSummaries } = musicSceneSummariesFromRows(
      sceneRows,
      allShots
    );
    if (sceneSummaries.length === 0) return none;
    const latest = await scopedDb.sequenceMusicPromptVersions.getLatest(
      sequence.id
    );
    const analysisModel = latest?.analysisModel ?? analysisModelId;
    const regenPrompt = !(await musicPromptInputHashMatches(
      sequence.musicPromptInputHash,
      { sceneSummaries, analysisModel },
      legacyShotSummaries
    ));
    return {
      regenPrompt,
      // Either the track's own hash diverged, or the prompt regen cascades
      // into it.
      regenTrack: trackStale || (regenPrompt && hasIdleTrack),
      sceneSummaries,
      analysisModelId,
      promptSource: latest ? 'regenerated' : 'ai-generated',
      durationSeconds,
    };
  } catch (error) {
    // Fail closed — same posture as per-shot 'unknown'.
    logger.warn(`music staleness uncomputable for sequence ${sequence.id}:`, {
      err: error,
    });
    return none;
  }
}

/**
 * A continue's music (#1818): the units say what to make — a first prompt or
 * track included. The children's inputs are frozen here exactly as for
 * Update all. Null when the plan owes no music.
 */
async function computeMusicPlanForUnits(
  scopedDb: ScopedDb,
  sequence: Sequence,
  allShots: Shot[],
  units: readonly PlanUnitRef[]
): Promise<MusicPlan | null> {
  const regenPrompt = units.some((u) => u.kind === 'prompt:music');
  const regenTrack = units.some((u) => u.kind === 'music');
  if (!regenPrompt && !regenTrack) return null;
  const [sceneRows, latest] = await Promise.all([
    scopedDb.scenes.listBySequence(sequence.id),
    scopedDb.sequenceMusicPromptVersions.getLatest(sequence.id),
  ]);
  return {
    regenPrompt,
    regenTrack,
    sceneSummaries: regenPrompt
      ? musicSceneSummariesFromRows(sceneRows, allShots).sceneSummaries
      : [],
    analysisModelId:
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL,
    promptSource: latest ? 'regenerated' : 'ai-generated',
    durationSeconds: musicRequestDurationSeconds(allShots),
  };
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
          usesStartFrame: target.usesStartFrame,
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
