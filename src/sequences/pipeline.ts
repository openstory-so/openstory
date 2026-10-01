/**
 * Generation pipeline stages — the user-facing DAG for "how far to run"
 * and "what's next" (#1408).
 *
 * One ordered list drives the generate-dialog slider, the progress banner,
 * and the scene-list continue button. Stop-at is chosen per run and
 * snapshotted onto `sequences.generationStopAt`; payload/estimator flags are
 * derived from it (`flagsFromStopAt`). What is left to generate is not a stage: it is the
 * generation plan (`generation-plan.ts`), derived from live rows.
 */

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

function stagesUpTo(stopAt: GenerationStage): GenerationStage[] {
  return GENERATION_STAGES.filter((stage) => includesStage(stopAt, stage));
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
 * Resolve how far a run should go: this click's stop-at, else the value
 * snapshotted onto the sequence. Every row has one (#1118 backfilled the
 * rows that predate it from the dropped auto-generate columns, and create
 * always writes it), so a missing stage is a bug and fails loudly.
 */
export function resolveStopAt(opts: {
  stopAt?: GenerationStage | null;
  generationStopAt: GenerationStage | null;
}): GenerationStage {
  const stage = coerceStage(opts.stopAt) ?? coerceStage(opts.generationStopAt);
  if (!stage) {
    throw new Error('Sequence has no generation stop-at');
  }
  return stage;
}

/** Voice-only characters never get a sheet; they do not count as misses. */
function characterNeedsReferenceSheet(character: {
  voiceOnly?: boolean | null;
}): boolean {
  return !character.voiceOnly;
}

function characterHasReferenceSheet(character: {
  sheetStatus?: string | null;
  sheetImageUrl?: string | null;
}): boolean {
  return (
    character.sheetStatus === 'completed' && Boolean(character.sheetImageUrl)
  );
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
  // next stop up. The quote and the run must use that stop too — Images still
  // owes the music prompt, and the next tick is Motion & Music.
  const next = stages.findIndex((s) => stageIndex(s) > stageIndex(stopAt));
  return next < 0 ? stages.length - 1 : next;
}

/** The stop the slider paints and stores for `stopAt`. */
export function sliderCommittedStop(
  stopAt: GenerationStage,
  referenceOnly: boolean,
  generateVoices = false
): GenerationStage {
  const stages = sliderStages(referenceOnly, generateVoices);
  return stopAtFromSliderIndex(sliderThumbIndex(stopAt, stages), stages);
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
