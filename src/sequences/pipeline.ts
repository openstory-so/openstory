/**
 * Generation pipeline stages — the user-facing DAG for "how far to run"
 * and "what's next" (#1408).
 *
 * One ordered list drives the generate-dialog slider, the progress banner,
 * and the scene-list continue button. Stop-at is chosen per run and
 * snapshotted onto `sequences.generationStopAt`; the auto-generate flags are
 * derived from it. Recovery reads artifacts + the last completed stage the
 * workflow persisted.
 */

import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/shots/scene-analysis.schema';
import type { CharacterMinimal } from '@/platform/server/db/schema/characters';
import type { MotionAudioClip } from '@/platform/server/db/schema/shot-prompt-versions';
import type { ShotDialogueLine } from '@/platform/server/db/schema/shot-dialogue-versions';
import type { SequenceElementMinimal } from '@/platform/server/db/schema/sequence-elements';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema/sequence-locations';
import type {
  LibraryLocationMatch,
  MotionMusicPromptsWorkflowResult,
  ShotImagesWorkflowResult,
  TalentCharacterMatch,
} from '@/platform/server/workflow/types';
import { z } from 'zod';

export const GENERATION_STAGES = [
  'script',
  'references',
  'images',
  'dialogue',
  'motion',
  'music',
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const generationStageSchema = z.enum(GENERATION_STAGES);

/**
 * Stages the scene-list continue button can start from. Script is a fresh
 * run; motion and music have their own batch footers.
 */
const CONTINUE_STAGES = ['references', 'images', 'dialogue'] as const;
export type ContinueStage = (typeof CONTINUE_STAGES)[number];
export const continueStageSchema = z.enum(CONTINUE_STAGES);

export function isContinueStage(
  stage: GenerationStage | null | undefined
): stage is ContinueStage {
  return stage === 'references' || stage === 'images' || stage === 'dialogue';
}

/**
 * Canvas continue: start-frames can still change only before Images has
 * run. After that, stills exist (or the sequence is already reference-only
 * because Images was skipped) and toggling would rewrite rendered shots.
 */
export function continueOffersStartFramesSwitch(
  startFrom: GenerationStage
): boolean {
  // Images has not run yet when continue starts at Images — still optional.
  return stageIndex(startFrom) <= stageIndex('images');
}

/**
 * Canvas continue: Voices can still change until Dialogue has finished.
 * Starting at Dialogue means clips have not run yet — turning Voices off
 * skips them for this continue.
 */
export function continueOffersVoicesSwitch(
  startFrom: GenerationStage
): boolean {
  return stageIndex(startFrom) <= stageIndex('dialogue');
}

/**
 * Apply start-frames / Voices edits from a continue click. Flags for
 * stages that have already run are ignored so a stale client cannot
 * rewrite them.
 */
export function resolveContinueGenerationFlags(args: {
  startFrom: GenerationStage;
  current: { generateStartFrames: boolean; generateVoices: boolean };
  requested?: {
    generateStartFrames?: boolean;
    generateVoices?: boolean;
  };
}): { generateStartFrames: boolean; generateVoices: boolean } {
  return {
    generateStartFrames:
      args.requested?.generateStartFrames !== undefined &&
      continueOffersStartFramesSwitch(args.startFrom)
        ? args.requested.generateStartFrames
        : args.current.generateStartFrames,
    generateVoices:
      args.requested?.generateVoices !== undefined &&
      continueOffersVoicesSwitch(args.startFrom)
        ? args.requested.generateVoices
        : args.current.generateVoices,
  };
}

/** Product default: stills + motion + music (the short-film aha). */
export const DEFAULT_GENERATION_STOP_AT: GenerationStage = 'music';

export const GENERATION_STAGE_META: Record<
  GenerationStage,
  {
    phase: number;
    name: string;
    shortName: string;
    description: string;
    /** Footer / dialog verb, e.g. "Generate Images". */
    actionLabel: string;
  }
> = {
  // Script covers scene-split AND casting: the cast, locations and elements
  // are created (without sheets) before this stage completes, so a stop here
  // shows the whole bible for review before any reference image is billed.
  script: {
    phase: 1,
    name: 'Analyzing script & casting\u2026',
    shortName: 'Casting',
    description:
      'Breaking your script into scenes and casting characters, locations & elements',
    actionLabel: 'Analyze Script',
  },
  references: {
    phase: 2,
    name: 'Generating references & prompts\u2026',
    shortName: 'References',
    description: 'Generating reference sheets and crafting visual prompts',
    actionLabel: 'Generate References',
  },
  images: {
    phase: 3,
    name: 'Generating images\u2026',
    shortName: 'Images',
    description: 'Generating images and writing motion & music prompts',
    actionLabel: 'Generate Images',
  },
  dialogue: {
    phase: 4,
    name: 'Generating dialogue\u2026',
    shortName: 'Dialogue',
    description: 'Synthesizing spoken lines for each shot',
    actionLabel: 'Generate Dialogue',
  },
  motion: {
    phase: 5,
    name: 'Generating motion\u2026',
    shortName: 'Motion',
    description: 'Generating motion video',
    actionLabel: 'Generate Motion',
  },
  music: {
    phase: 6,
    name: 'Generating music\u2026',
    shortName: 'Music',
    description: 'Generating the sequence music track',
    // The `music` stop runs motion AND music in one workflow child, which is
    // why the slider calls it "Motion & Music". The button has to promise the
    // same thing — "Generate Music" under-sold the whole motion pass (#1408).
    actionLabel: 'Generate Motion & Music',
  },
};

export function isGenerationStage(value: unknown): value is GenerationStage {
  return (
    typeof value === 'string' &&
    (GENERATION_STAGES as readonly string[]).includes(value)
  );
}

/** Stored stage → current stage; anything unknown is null. */
function coerceStage(value: unknown): GenerationStage | null {
  return isGenerationStage(value) ? value : null;
}

export function stageIndex(stage: GenerationStage): number {
  return GENERATION_STAGES.indexOf(stage);
}

/** True when the run that stops at `stopAt` will execute `stage`. */
export function includesStage(
  stopAt: GenerationStage,
  stage: GenerationStage
): boolean {
  return stageIndex(stage) <= stageIndex(stopAt);
}

/**
 * Script analysis with no credits (#1566). Sheets, images, motion, and
 * music still go through the usual credit gate.
 */
export function allowsUnfundedGeneration(stopAt: GenerationStage): boolean {
  return stopAt === 'script';
}

/**
 * True when a continue run that starts at `startFrom` and stops at `stopAt`
 * should execute `stage`.
 */
export function shouldRunStage(
  startFrom: GenerationStage,
  stopAt: GenerationStage,
  stage: GenerationStage
): boolean {
  const i = stageIndex(stage);
  return i >= stageIndex(startFrom) && i <= stageIndex(stopAt);
}

export function stagesUpTo(stopAt: GenerationStage): GenerationStage[] {
  return GENERATION_STAGES.filter((stage) => includesStage(stopAt, stage));
}

export function nextStageAfter(
  completed: GenerationStage | null
): GenerationStage | null {
  if (completed === null) return 'script';
  const i = stageIndex(completed);
  return GENERATION_STAGES[i + 1] ?? null;
}

export function flagsFromStopAt(stopAt: GenerationStage): {
  autoGenerateMotion: boolean;
  autoGenerateMusic: boolean;
} {
  return {
    autoGenerateMotion: includesStage(stopAt, 'motion'),
    autoGenerateMusic: includesStage(stopAt, 'music'),
  };
}

/**
 * Map the legacy auto-generate booleans onto a stop-at stage. Music without
 * motion is dropped (music currently requires motion clips), so that run
 * stops at images.
 */
export function stopAtFromFlags(flags: {
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
}): GenerationStage {
  if (flags.autoGenerateMotion && flags.autoGenerateMusic) return 'music';
  if (flags.autoGenerateMotion) return 'motion';
  return 'images';
}

/**
 * Resolve how far a run should go. The explicit stop-at (this click, or the
 * value snapshotted onto the sequence) wins. Flags are last-resort for rows
 * that predate `generationStopAt` — they cannot express Script/References,
 * so they must not override a stored stage.
 */
export function resolveStopAt(opts: {
  stopAt?: GenerationStage | null;
  generationStopAt?: GenerationStage | null;
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
}): GenerationStage {
  return (
    coerceStage(opts.stopAt) ??
    coerceStage(opts.generationStopAt) ??
    stopAtFromFlags({
      autoGenerateMotion: opts.autoGenerateMotion,
      autoGenerateMusic: opts.autoGenerateMusic,
    })
  );
}

/**
 * Observable artifacts + the workflow's last completed stage. Artifacts are
 * the evidence (a crash after images landed but before the stage write still
 * looks like images). `pipelineStage` is a floor for continue stages so a
 * finished step cannot be offered again when shot rows lag the persist.
 */
export type PipelineArtifacts = {
  hasScenes: boolean;
  hasVisualPrompts: boolean;
  hasImages: boolean;
  hasMotion: boolean;
  hasMusic: boolean;
  /**
   * On-screen character sheets that the References stage still owes. `false`
   * keeps the sequence at Casting even when visual prompts already exist
   * (#1727). Omitted when the canvas has not loaded the cast yet.
   */
  hasReferenceSheets?: boolean;
  pipelineStage?: GenerationStage | null;
  generateVoices?: boolean;
};

export type ReferenceSheetRow = {
  voiceOnly?: boolean | null;
  sheetStatus?: string | null;
  sheetImageUrl?: string | null;
};

/** Voice-only characters never get a sheet; they do not count as misses. */
function characterNeedsReferenceSheet(
  character: Pick<ReferenceSheetRow, 'voiceOnly'>
): boolean {
  return !character.voiceOnly;
}

function characterHasReferenceSheet(
  character: Pick<ReferenceSheetRow, 'sheetStatus' | 'sheetImageUrl'>
): boolean {
  return (
    character.sheetStatus === 'completed' && Boolean(character.sheetImageUrl)
  );
}

/**
 * Remaining / total on-screen sheets for the references continue CTA
 * (`Generate 1 / 3 references`).
 */
export function referenceSheetProgress(
  characters: ReadonlyArray<ReferenceSheetRow>
): { remaining: number; total: number } {
  const needed = characters.filter(characterNeedsReferenceSheet);
  return {
    remaining: needed.filter((c) => !characterHasReferenceSheet(c)).length,
    total: needed.length,
  };
}

/**
 * True when every on-screen bible entry has a completed sheet. Voice-only
 * characters are complete by design. An empty bible is ready.
 */
export function characterReferenceSheetsReady(
  bible: ReadonlyArray<{ characterId: string; voiceOnly?: boolean | null }>,
  sheets: ReadonlyArray<{
    characterId: string;
    sheetStatus?: string | null;
    sheetImageUrl?: string | null;
  }>
): boolean {
  const needed = bible.filter((c) => characterNeedsReferenceSheet(c));
  if (needed.length === 0) return true;
  const byId = new Map(sheets.map((row) => [row.characterId, row]));
  return needed.every((entry) => {
    const row = byId.get(entry.characterId);
    return row != null && characterHasReferenceSheet(row);
  });
}

export function completedStageFromArtifacts(
  artifacts: PipelineArtifacts
): GenerationStage | null {
  // Music outlives a re-run that deleted every shot; on its own it would hide
  // the whole board behind a finished pipeline.
  let completed: GenerationStage | null = null;
  if (artifacts.hasMusic && artifacts.hasMotion) completed = 'music';
  else if (artifacts.hasMotion) completed = 'motion';
  else if (artifacts.hasImages) completed = 'images';
  else if (artifacts.hasVisualPrompts && artifacts.hasReferenceSheets !== false)
    completed = 'references';
  else if (artifacts.hasScenes) completed = 'script';

  // Shot rows can lag the persist (prompts not mirrored yet). A persisted
  // continue-stage is still done — otherwise the canvas slider offers the
  // same step again (#1698). Motion/music still need files: leftover music
  // after a shot wipe must not look finished.
  const persisted = coerceStage(artifacts.pipelineStage);
  if (
    persisted &&
    persisted !== 'motion' &&
    persisted !== 'music' &&
    (completed === null || stageIndex(persisted) > stageIndex(completed))
  ) {
    completed = persisted;
  }
  // A failed character sheet must not look like References is done, even if
  // visual prompts landed or a persist wrote the stage before this rule (#1727).
  if (
    artifacts.hasReferenceSheets === false &&
    completed !== null &&
    stageIndex(completed) >= stageIndex('references') &&
    stageIndex(completed) < stageIndex('images')
  ) {
    completed = artifacts.hasScenes ? 'script' : null;
  }
  return completed;
}

/**
 * Next stage a continue click may start from, given the checkpoint the last
 * run persisted. Skips Images when start frames are off and Dialogue when
 * Voices is off — same skips as the canvas slider.
 */
export function continueReachableFrom(
  completed: GenerationStage,
  opts: { generateStartFrames: boolean; generateVoices: boolean }
): GenerationStage | null {
  let reachable = nextStageAfter(completed);
  if (reachable === 'images' && !opts.generateStartFrames) {
    reachable = nextStageAfter(reachable);
  }
  if (reachable === 'dialogue' && !opts.generateVoices) {
    reachable = nextStageAfter(reachable);
  }
  return reachable;
}

/**
 * Continue start for the canvas footer after the user toggles start frames
 * or Voices. `nextStage` is the sequence's next unrun stage; draft flags
 * may skip it (Images off, Voices off).
 */
export function continueStartFrom(
  nextStage: GenerationStage,
  flags: { generateStartFrames: boolean; generateVoices: boolean }
): GenerationStage | null {
  if (nextStage === 'images' && !flags.generateStartFrames) {
    return continueReachableFrom('references', flags);
  }
  if (nextStage === 'dialogue' && !flags.generateVoices) {
    return continueReachableFrom(
      flags.generateStartFrames ? 'images' : 'references',
      flags
    );
  }
  return nextStage;
}

/**
 * A continue click may still send the stage the footer was sitting on
 * (Images) after draft flags skipped it to Dialogue or Motion. Accept that
 * and run from `reachable`. Reject a start that would re-run a completed
 * stage or jump past what the checkpoint can hydrate.
 */
export function alignContinueStartFrom(
  requested: GenerationStage,
  reachable: GenerationStage,
  flags: { generateStartFrames: boolean; generateVoices: boolean }
): GenerationStage | null {
  if (requested === reachable) return reachable;
  if (stageIndex(requested) > stageIndex(reachable)) return null;
  return continueStartFrom(requested, flags) === reachable ? reachable : null;
}

/**
 * The next stage the continue button should offer. Null when nothing has
 * been generated yet (composer Generate owns that) or the pipeline is finished.
 */
export function nextActionFromArtifacts(
  artifacts: PipelineArtifacts
): GenerationStage | null {
  const completed = completedStageFromArtifacts(artifacts);
  if (completed === null) return null;
  let next = nextStageAfter(completed);
  // Match the Generate slider: only offer the separate Dialogue stop when
  // Voices is on. Otherwise any existing talent voices ride with motion.
  if (next === 'dialogue' && !artifacts.generateVoices)
    next = nextStageAfter(next);
  return next;
}

/**
 * Scene-list continue CTA. Null while a run is in flight: visual prompts
 * stream in before references finishes, so a live DAG read would offer
 * "Generate Images" mid-run (#1408).
 */
export function continueStageFromState(args: {
  isProcessing: boolean;
  artifacts: PipelineArtifacts;
}): GenerationStage | null {
  if (args.isProcessing) return null;
  return nextActionFromArtifacts(args.artifacts);
}

export function actionLabelForStage(
  stage: GenerationStage,
  opts?: {
    generateStartFrames?: boolean;
    startFrom?: GenerationStage;
    remaining?: number;
    total?: number;
    draftFirst?: boolean;
  }
): string {
  if ((stage === 'music' || stage === 'motion') && opts?.draftFirst) {
    return 'Generate Drafts & Music';
  }
  if (
    stage === 'dialogue' &&
    opts?.generateStartFrames &&
    opts.startFrom != null &&
    shouldRunStage(opts.startFrom, stage, 'images')
  ) {
    return 'Generate Start Frames & Dialogue';
  }
  if (
    stage === 'references' &&
    opts?.remaining != null &&
    opts.total != null &&
    opts.total > 0
  ) {
    return `Generate ${opts.remaining} / ${opts.total} ${opts.total === 1 ? 'reference' : 'references'}`;
  }
  return GENERATION_STAGE_META[stage].actionLabel;
}

/** Derive DAG artifacts from the sequence + shot list the scene rail already has. */
export function artifactsFromSequenceState(args: {
  sceneCount: number;
  shots: ReadonlyArray<{
    imagePromptVersion: unknown;
    frame: { imageStatus: string | null };
    videoStatus: string;
  }>;
  musicStatus?: string | null;
  musicUrl?: string | null;
  pipelineStage?: GenerationStage | null;
  /**
   * Reference-only writes no frame prompts and renders no stills, so those
   * artifacts never appear. The stage the workflow persisted after References
   * is the only evidence, and it covers Images too — nothing renders there,
   * so the next action after References is Dialogue (Voices on) or Motion.
   */
  referenceOnly?: boolean;
  generateVoices?: boolean;
  characters?: ReadonlyArray<ReferenceSheetRow>;
}): PipelineArtifacts {
  const { shots } = args;
  const reached = coerceStage(args.pipelineStage);
  const referencesDone =
    reached !== null && stageIndex(reached) >= stageIndex('references');
  return {
    hasScenes: args.sceneCount > 0,
    hasVisualPrompts: args.referenceOnly
      ? referencesDone
      : shots.length > 0 &&
        shots.every((shot) => shot.imagePromptVersion != null),
    hasImages: args.referenceOnly
      ? referencesDone
      : shots.length > 0 &&
        shots.every((shot) => shot.frame.imageStatus === 'completed'),
    hasMotion:
      shots.length > 0 &&
      shots.every((shot) => shot.videoStatus === 'completed'),
    hasMusic: args.musicStatus === 'completed' && Boolean(args.musicUrl),
    hasReferenceSheets:
      args.characters === undefined
        ? undefined
        : referenceSheetProgress(args.characters).remaining === 0,
    pipelineStage: args.pipelineStage,
    generateVoices: args.generateVoices,
  };
}

/**
 * Persisted mid-pipeline snapshot so a stopped run can resume without
 * re-reading mutable D1 inside the workflow. Written after each completed
 * stage; the continue launcher copies it onto the next run's payload.
 *
 * The sheet rows are the same shapes the References children return, so a
 * continue feeds shot-images exactly what a fresh run would — including the
 * version ids the still's manifest hashes against. Type-only imports, so
 * the schema → pipeline → schema loop never exists at runtime.
 */
export type GenerationCheckpoint = {
  completedStage: GenerationStage;
  scenes?: Scene[];
  shotMapping?: Array<{
    analysisSceneId: string;
    shotId: string;
    frameId: string | null;
    shotNumber?: number;
  }>;
  characterBible?: CharacterBibleEntry[];
  locationBible?: LocationBibleEntry[];
  elementBible?: ElementBibleEntry[];
  talentMatches?: TalentCharacterMatch[];
  locationMatches?: LibraryLocationMatch[];
  charactersWithSheets?: CharacterMinimal[];
  locationsWithSheets?: SequenceLocationMinimal[];
  allElements?: SequenceElementMinimal[];
  visualPromptBySceneId?: Record<string, string>;
  scenesWithVisualPrompts?: Scene[];
  /** Selected stills and prompts snapshotted for a Dialogue or Motion continue. */
  imageStage?: {
    images: ShotImagesWorkflowResult;
    prompts: MotionMusicPromptsWorkflowResult;
  };
  /** Per-shot Text to Dialogue clips from the Dialogue stage (#1554 / #1629). */
  dialogueClipsByShotId?: Record<string, MotionAudioClip[]>;
  /**
   * Authored dialogue per SHOT id (#1657), snapshotted so the Dialogue stage
   * never reads the shot node mid-run. Re-read from D1 at a continue
   * (`refreshCheckpointFromCast`), so a line edited while the run was stopped
   * is what gets recorded. A shot absent from here has no version row yet and
   * is derived from its scene's script.
   */
  dialogueLinesByShotId?: Record<string, ShotDialogueLine[]>;
  /**
   * The `shot_dialogue_versions` row each entry above came from, so a
   * recorded section can name the lines it spoke. Same lifecycle; absent for
   * a shot whose lines were derived.
   */
  dialogueVersionIdByShotId?: Record<string, string>;
};

/**
 * Progress-banner phases for a run that stops at `stopAt`. Music rides with
 * motion in one workflow child, so a music stop still has four banner
 * segments — the last one labelled "Motion & Music".
 */
export function bannerStagesForStopAt(
  stopAt: GenerationStage,
  opts: { referenceOnly?: boolean; generateVoices?: boolean } = {}
): GenerationStage[] {
  let stages = stagesUpTo(stopAt);
  if (includesStage(stopAt, 'music')) {
    stages = stages.filter((stage) => stage !== 'music');
  }
  if (opts.referenceOnly) {
    stages = stages.filter((stage) => stage !== 'images');
  }
  if (!opts.generateVoices) {
    stages = stages.filter((stage) => stage !== 'dialogue');
  }
  return stages;
}

/**
 * Generate-dialog / continue-slider stops. Same as a full-run banner — the
 * last thumb is Motion & Music (`stopAt: 'music'`). Reference-only has no
 * Images stop. Voices off has no Dialogue stop — clips still run before
 * motion when a talent already holds a voiceId. Start frames + Voices share
 * one start-frames-and-dialogue stop (the two ticks do not fit on the canvas slider).
 */
export function sliderStages(
  referenceOnly: boolean,
  generateVoices = false
): GenerationStage[] {
  const stages = bannerStagesForStopAt('music', {
    referenceOnly,
    generateVoices,
  });
  if (!referenceOnly && generateVoices) {
    return stages.filter((stage) => stage !== 'images');
  }
  return stages;
}

export function sliderThumbIndex(
  stopAt: GenerationStage,
  stages: readonly GenerationStage[]
): number {
  if (stopAt === 'music' || stopAt === 'motion') {
    return stages.length - 1;
  }
  const index = stages.indexOf(stopAt);
  if (index >= 0) return index;
  // A stop the slider does not offer (Images in reference-only) shows on the
  // next stop up; nothing renders in Images there, so the two look the same.
  const next = stages.findIndex((s) => stageIndex(s) > stageIndex(stopAt));
  return next < 0 ? stages.length - 1 : next;
}

export function stopAtFromSliderIndex(
  index: number,
  stages: readonly GenerationStage[]
): GenerationStage {
  const last = stages.length - 1;
  const clamped = Math.max(0, Math.min(index, last));
  const stage = stages[clamped] ?? 'script';
  return stage === 'motion' ? 'music' : stage;
}

export function sliderStopLabel(
  stopAt: GenerationStage,
  opts?: { generateStartFrames?: boolean; draftFirst?: boolean }
): string {
  // Draft first (#1756): the motion pass renders 480p drafts (music rides
  // along as usual); the 1080p finals are a continue, never an auto-run.
  if (stopAt === 'music' || stopAt === 'motion') {
    return opts?.draftFirst ? 'Drafts' : 'Motion & Music';
  }
  if (stopAt === 'references') return 'References & Prompts';
  if (stopAt === 'dialogue' && opts?.generateStartFrames) {
    return 'Start Frames & Dialogue';
  }
  return GENERATION_STAGE_META[stopAt].shortName;
}

/**
 * Tick copy: keep "X & Y" on at most two lines (`Motion &` / `Music`), never
 * three (`Motion` / `&` / `Music`).
 */
export function sliderTickLabel(
  stopAt: GenerationStage,
  opts?: { generateStartFrames?: boolean; draftFirst?: boolean }
): string {
  return sliderStopLabel(stopAt, opts).replace(' & ', '\u00a0&\n');
}

/**
 * Whole sentences, not "Stop after" + a label: a translator needs the noun
 * and the verb together.
 */
const STOP_AFTER_SENTENCE: Record<GenerationStage, string> = {
  script: 'Stop after casting',
  references: 'Stop after references & prompts',
  images: 'Stop after images',
  dialogue: 'Stop after dialogue',
  motion: 'Don’t stop',
  music: 'Don’t stop',
};

export function stopAfterSentence(
  stopAt: GenerationStage,
  opts?: { generateStartFrames?: boolean; draftFirst?: boolean }
): string {
  if (stopAt === 'dialogue' && opts?.generateStartFrames) {
    return 'Stop after start frames & dialogue';
  }
  if ((stopAt === 'music' || stopAt === 'motion') && opts?.draftFirst) {
    return 'Stop after drafts';
  }
  return STOP_AFTER_SENTENCE[stopAt];
}

/**
 * The Generate-button scope line (#1526): names the current stop-at.
 * Same "Stops after {stage}" copy as main; a full run is "Whole sequence".
 */
export function runScopeLabel(
  stopAt: GenerationStage,
  opts?: {
    generateStartFrames?: boolean;
    generateVoices?: boolean;
    draftFirst?: boolean;
  }
): string {
  if (stopAt === 'music' || stopAt === 'motion') {
    return opts?.draftFirst ? 'Stops after drafts' : 'Whole sequence';
  }
  const stage =
    stopAt === 'images' && opts?.generateStartFrames && opts.generateVoices
      ? 'dialogue'
      : stopAt;
  return `Stops after ${sliderStopLabel(stage, opts)}`;
}
