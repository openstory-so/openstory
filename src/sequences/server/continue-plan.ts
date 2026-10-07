/**
 * What a continue click may run (#1817): the generation plan, filtered to
 * work up to the stop. The plan is the only opinion — no checkpoint stage, no
 * `startFrom` from the client — so the footer and this guard cannot disagree.
 */

import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';
import { estimateImageCost, estimatePlanCost } from '@/billing/cost-estimation';
import type { Microdollars } from '@/billing/money';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import { ValidationError } from '@/platform/errors';
import type { Sequence, Shot } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { computeGenerationPlan } from './generation-plan';
import { getSequenceRejectingActiveRun } from './launchers';
import {
  planCounts,
  planWork,
  switchLocks,
  switchStopAt,
  type PlanUnit,
} from '@/sequences/generation-plan';
import { sliderStopLabel, type GenerationStage } from '@/sequences/pipeline';

type Flags = { generateStartFrames: boolean; generateVoices: boolean };

export function continueFromPlan(args: {
  /** The plan under the saved flags — what already exists. */
  current: readonly PlanUnit[];
  /** The plan under the requested flags — what this click would owe. */
  next: readonly PlanUnit[];
  saved: Flags;
  requested: Flags;
  stopAt: GenerationStage;
}): { work: PlanUnit[]; stopAt: GenerationStage } {
  const locks = switchLocks(args.current);
  if (
    args.saved.generateVoices &&
    !args.requested.generateVoices &&
    locks.voices
  ) {
    throw new ValidationError(
      'Voices can’t be turned off: shots already have recorded dialogue'
    );
  }
  const stopAt = switchStopAt({ ...args, plan: args.next });
  const work = planWork(args.next, stopAt);
  if (work.length === 0) {
    throw new ValidationError(
      `Nothing to generate up to ${sliderStopLabel(stopAt)}`
    );
  }
  return { work, stopAt };
}

/**
 * The quote and the reservation for a continue: the plan's work, priced per
 * unit. `priced` is false when a still is owed and its model has no price —
 * the footer shows no estimate, the gate reserves the floored number.
 */
export async function estimateContinueCost(args: {
  sequence: Pick<
    Sequence,
    'imageModel' | 'videoModel' | 'musicModel' | 'aspectRatio' | 'resolution'
  >;
  shots: ReadonlyArray<Pick<Shot, 'durationMs'>>;
  work: readonly PlanUnit[];
  generateStartFrames: boolean;
  draftMotion: boolean;
}): Promise<{ micros: Microdollars; priced: boolean }> {
  const { sequence, shots } = args;
  const pricing = await getEffectiveFalPricing();
  const imageModel = safeTextToImageModel(
    sequence.imageModel,
    DEFAULT_IMAGE_MODEL
  );
  const counts = planCounts(args.work);
  // A sheet pointed at instead of drawn is free (#2017).
  counts['sheet:character'] -= args.work.filter((u) => u.reused).length;
  const priced =
    counts.still === 0 ||
    estimateImageCost(imageModel, sequence.aspectRatio, 1, { pricing }) !==
      null;
  const videoModel = safeImageToVideoModel(
    sequence.videoModel,
    DEFAULT_VIDEO_MODEL
  );
  const micros = estimatePlanCost({
    counts,
    imageModel,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    videoModels: [videoModel],
    videoDurationSeconds: resolveShotDuration({
      durationMs: shots[0]?.durationMs,
      model: videoModel,
    }),
    referenceOnly: !args.generateStartFrames,
    draftMotion: args.draftMotion,
    audioModels: [safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)],
    audioDurationSeconds: musicRequestDurationSeconds(shots),
    pricing,
  });
  return { micros, priced };
}

/**
 * The one gate and work list for Continue, shared by the editor and MCP. The
 * sequence must not be running a storyboard (the switches a click saves are
 * snapshotted by the trigger). `requested` is the start-frame and voice
 * switches the run uses; an agent passes the saved ones. The caller checks
 * `estimate.micros` against the balance (a check, not a hold, #1818).
 */
export async function prepareContinue(args: {
  scopedDb: ScopedDb;
  sequence: Sequence;
  stopAt: GenerationStage;
  requested: { generateStartFrames: boolean; generateVoices: boolean };
  draftMotion: boolean;
  /** The live plan under the saved switches, when already computed. */
  generationPlan?: readonly PlanUnit[];
}) {
  const { scopedDb, sequence, requested } = args;
  await getSequenceRejectingActiveRun(scopedDb, sequence.id);
  const saved = {
    generateStartFrames: sequence.generateStartFrames,
    generateVoices: sequence.generateVoices,
  };
  const current =
    args.generationPlan ?? (await computeGenerationPlan(scopedDb, sequence.id));
  const next =
    saved.generateStartFrames === requested.generateStartFrames &&
    saved.generateVoices === requested.generateVoices
      ? current
      : await computeGenerationPlan(scopedDb, sequence.id, requested);
  const { work, stopAt } = continueFromPlan({
    current,
    next,
    saved,
    requested,
    stopAt: args.stopAt,
  });
  const estimate = await estimateContinueCost({
    sequence,
    shots: await scopedDb.shots.listBySequence(sequence.id),
    work,
    generateStartFrames: requested.generateStartFrames,
    draftMotion: args.draftMotion,
  });
  return { work, stopAt, estimate };
}

/** Whose keys waive Continue's balance check (script analysis + renders). */
export const CONTINUE_CREDIT_PROVIDERS = ['fal', 'openrouter'] as const;
