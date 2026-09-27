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
import {
  firstStageWithWork,
  planCounts,
  planWork,
  switchLocks,
  type PlanUnit,
} from '@/sequences/generation-plan';
import {
  GENERATION_STAGE_META,
  isContinueStage,
  sliderStopLabel,
  type ContinueStage,
  type GenerationStage,
} from '@/sequences/pipeline';

type Flags = { generateStartFrames: boolean; generateVoices: boolean };

export function continueFromPlan(args: {
  /** The plan under the saved flags — what already exists. */
  current: readonly PlanUnit[];
  /** The plan under the requested flags — what this click would owe. */
  next: readonly PlanUnit[];
  saved: Flags;
  requested: Flags;
  stopAt: GenerationStage;
}): { work: PlanUnit[]; startFrom: ContinueStage } {
  const locks = switchLocks(args.current);
  if (
    args.saved.generateStartFrames &&
    !args.requested.generateStartFrames &&
    locks.startFrames
  ) {
    throw new ValidationError(
      'Start frames can’t be turned off: shots already have stills'
    );
  }
  if (
    args.saved.generateVoices &&
    !args.requested.generateVoices &&
    locks.voices
  ) {
    throw new ValidationError(
      'Voices can’t be turned off: shots already have recorded dialogue'
    );
  }
  const work = planWork(args.next, args.stopAt);
  if (work.length === 0) {
    throw new ValidationError(
      `Nothing to generate up to ${sliderStopLabel(args.stopAt)}`
    );
  }
  return { work, startFrom: legacyStartFrom(work) };
}

/**
 * Phase-2 shim, deleted with #1818: the storyboard run is still stage-shaped,
 * so it starts at the earliest stage the plan has work in. Motion and music
 * keep their own footers until the run takes units.
 */
function legacyStartFrom(work: readonly PlanUnit[]): ContinueStage {
  const stage = firstStageWithWork(work) ?? 'motion';
  if (isContinueStage(stage)) return stage;
  throw new ValidationError(
    `Nothing before ${GENERATION_STAGE_META[stage].shortName} to generate — use Generate ${stage === 'music' ? 'Music' : 'Motion'}`
  );
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
