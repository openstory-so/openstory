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
} from '@/lib/ai/scene-analysis.schema';
import type { CharacterMinimal } from '@/lib/db/schema/characters';
import type { SequenceElementMinimal } from '@/lib/db/schema/sequence-elements';
import type { SequenceLocationMinimal } from '@/lib/db/schema/sequence-locations';
import type {
  LibraryLocationMatch,
  TalentCharacterMatch,
} from '@/lib/workflow/types';
import { z } from 'zod';

export const GENERATION_STAGES = [
  'script',
  'references',
  'images',
  'motion',
  'music',
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const generationStageSchema = z.enum(GENERATION_STAGES);

/**
 * Stages the scene-list continue button can start from. Script is a fresh
 * run; motion and music have their own batch footers.
 */
const CONTINUE_STAGES = ['references', 'images'] as const;
export type ContinueStage = (typeof CONTINUE_STAGES)[number];
export const continueStageSchema = z.enum(CONTINUE_STAGES);

export function isContinueStage(
  stage: GenerationStage | null | undefined
): stage is ContinueStage {
  return stage === 'references' || stage === 'images';
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
    shortName: 'Script',
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
  motion: {
    phase: 4,
    name: 'Generating motion\u2026',
    shortName: 'Motion',
    description: 'Generating motion video',
    actionLabel: 'Generate Motion',
  },
  music: {
    phase: 5,
    name: 'Generating music\u2026',
    shortName: 'Music',
    description: 'Generating the sequence music track',
    // The `music` stop runs motion AND music in one workflow child, which is
    // why the slider calls it "Music & Motion". The button has to promise the
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
 * looks like images); `pipelineStage` only vouches for Script, whose scenes
 * can be deleted by hand.
 */
export type PipelineArtifacts = {
  hasScenes: boolean;
  hasVisualPrompts: boolean;
  hasImages: boolean;
  hasMotion: boolean;
  hasMusic: boolean;
  pipelineStage?: GenerationStage | null;
};

export function completedStageFromArtifacts(
  artifacts: PipelineArtifacts
): GenerationStage | null {
  // Music outlives a re-run that deleted every shot; on its own it would hide
  // the whole board behind a finished pipeline.
  if (artifacts.hasMusic && artifacts.hasMotion) return 'music';
  if (artifacts.hasMotion) return 'motion';
  if (artifacts.hasImages) return 'images';
  if (artifacts.hasVisualPrompts) return 'references';
  if (artifacts.hasScenes || coerceStage(artifacts.pipelineStage) === 'script')
    return 'script';
  return null;
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
  return nextStageAfter(completed);
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

export function actionLabelForStage(stage: GenerationStage): string {
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
   * so the next action after References is Motion.
   */
  referenceOnly?: boolean;
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
    pipelineStage: args.pipelineStage,
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
};

/**
 * Progress-banner phases for a run that stops at `stopAt`. Music rides with
 * motion in one workflow child, so a music stop still has four banner
 * segments — the last one labelled "Music & Motion".
 */
export function bannerStagesForStopAt(
  stopAt: GenerationStage
): GenerationStage[] {
  const stages = stagesUpTo(stopAt);
  return includesStage(stopAt, 'music')
    ? stages.filter((stage) => stage !== 'music')
    : stages;
}

/**
 * Generate-dialog / continue-slider stops. Same as a full-run banner — the
 * last thumb is Music & Motion (`stopAt: 'music'`). Reference-only has no
 * Images stop: nothing renders there, so the thumb goes References → Motion.
 */
export function sliderStages(referenceOnly: boolean): GenerationStage[] {
  return bannerStagesForStopAt('music').filter(
    (stage) => !(referenceOnly && stage === 'images')
  );
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

export function sliderStopLabel(stopAt: GenerationStage): string {
  if (stopAt === 'music' || stopAt === 'motion') return 'Music & Motion';
  return GENERATION_STAGE_META[stopAt].shortName;
}

export function sliderStopDescription(stopAt: GenerationStage): string {
  if (stopAt === 'music' || stopAt === 'motion') {
    return 'Generating motion video and music';
  }
  return GENERATION_STAGE_META[stopAt].description;
}
