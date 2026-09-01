/**
 * Generation pipeline stages — the user-facing DAG for "how far to run"
 * and "what's next" (#1408).
 *
 * One ordered list drives the generate-dialog slider, the progress banner,
 * and the scene-list continue button. Stop-at is a per-run choice (not a
 * stored auto-generate flag). Recovery reads artifacts + the last completed
 * stage the workflow persisted.
 */

import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import { z } from 'zod';

export const GENERATION_STAGES = [
  'script',
  'casting',
  'references',
  'images',
  'motion',
  'music',
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const generationStageSchema = z.enum(GENERATION_STAGES);

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
  script: {
    phase: 1,
    name: 'Analyzing script\u2026',
    shortName: 'Script',
    description: 'Reading your script and breaking it into scenes',
    actionLabel: 'Analyze Script',
  },
  casting: {
    phase: 2,
    name: 'Casting characters & locations\u2026',
    shortName: 'Casting',
    description: 'Casting characters and matching locations',
    actionLabel: 'Cast Characters',
  },
  references: {
    phase: 3,
    name: 'Generating references & prompts\u2026',
    shortName: 'References',
    description: 'Generating reference sheets and crafting visual prompts',
    actionLabel: 'Generate References',
  },
  images: {
    phase: 4,
    name: 'Generating images\u2026',
    shortName: 'Images',
    description: 'Generating images and writing motion & music prompts',
    actionLabel: 'Generate Images',
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
    actionLabel: 'Generate Music',
  },
};

export function isGenerationStage(value: unknown): value is GenerationStage {
  return (
    typeof value === 'string' &&
    (GENERATION_STAGES as readonly string[]).includes(value)
  );
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
 * motion collapses to motion (music currently requires motion clips).
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
 * that predate `generationStopAt` — they cannot express Script/Casting/
 * References, so they must not override a stored stage.
 */
export function resolveStopAt(opts: {
  stopAt?: GenerationStage | null;
  generationStopAt?: GenerationStage | null;
  autoGenerateMotion?: boolean;
  autoGenerateMusic?: boolean;
}): GenerationStage {
  if (isGenerationStage(opts.stopAt)) return opts.stopAt;
  if (isGenerationStage(opts.generationStopAt)) return opts.generationStopAt;
  return stopAtFromFlags({
    autoGenerateMotion: opts.autoGenerateMotion,
    autoGenerateMusic: opts.autoGenerateMusic,
  });
}

/**
 * Observable artifacts + the workflow's last completed stage. Artifact
 * flags win when they contradict `pipelineStage` (a crash after images
 * landed but before the stage write still looks like images).
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
  if (artifacts.hasMusic) return 'music';
  if (artifacts.hasMotion) return 'motion';
  if (artifacts.hasImages) return 'images';
  if (artifacts.hasVisualPrompts) return 'references';
  if (
    artifacts.pipelineStage === 'casting' ||
    artifacts.pipelineStage === 'script'
  ) {
    return artifacts.pipelineStage;
  }
  if (artifacts.hasScenes) return 'script';
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
}): PipelineArtifacts {
  const { shots } = args;
  return {
    hasScenes: args.sceneCount > 0,
    hasVisualPrompts:
      shots.length > 0 &&
      shots.every((shot) => shot.imagePromptVersion != null),
    hasImages:
      shots.length > 0 &&
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
 * Structural (not Drizzle) types so sequences.ts can import this module
 * without a cycle, and every field is JSON-serializable for server fns.
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
  talentMatches?: Array<{
    characterId: string;
    talentId: string;
    talentName: string;
    sheetImageUrl: string;
    talentDescription?: string;
  }>;
  locationMatches?: Array<{
    locationId: string;
    libraryLocationId: string;
    libraryLocationName: string;
    referenceImageUrl: string;
    description?: string;
  }>;
  charactersWithSheets?: Array<{
    id: string;
    characterId: string;
    name: string;
    sheetImageUrl: string | null;
    sheetStatus: string | null;
    sheetInputHash: string | null;
    selectedSheetVersionId: string | null;
    physicalDescription: string | null;
    consistencyTag: string | null;
  }>;
  locationsWithSheets?: Array<{
    id: string;
    locationId: string;
    name: string;
    referenceImageUrl: string | null;
  }>;
  allElements?: Array<{
    id: string;
    token: string;
    description: string | null;
    imageUrl: string;
    consistencyTag: string | null;
  }>;
  visualPromptBySceneId?: Record<string, string>;
  scenesWithVisualPrompts?: Scene[];
};

/**
 * Progress-banner phases for a run that stops at `stopAt`. Music rides with
 * motion in one workflow child, so a music stop still has five banner
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
