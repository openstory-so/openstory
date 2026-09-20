/**
 * "Update all" dry-run preview (#1194) — turn a max-depth `computePlan` result
 * into the concrete cascade the dialog shows: which artifacts on which shots
 * regenerate at each depth, and the cumulative cost estimate. Pure: the plan
 * is already computed and nothing here writes.
 */

import {
  estimateAudioCost,
  estimateImageCost,
  estimateLLMCost,
  estimateVideoCost,
} from '@/billing/cost-estimation';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';

type FalPricingMap = Record<string, EffectiveFalPricing>;
import { safeAudioModel, safeImageToVideoModel } from '@/models/models';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import { ttsCharacterCount } from '@/motion/dialogue-tts';
import type { UpdateStalePlan } from './update-stale-plan';
import type { UpdateStaleDepth } from '@/shots/update-stale-depth';

export type UpdateStalePreview = {
  visualPromptShotIds: string[];
  motionPromptShotIds: string[];
  imageShotIds: string[];
  dialogueShotIds: string[];
  videoShotIds: string[];
  musicPrompt: boolean;
  musicTrack: boolean;
  /**
   * Estimated cost of each level's OWN additions (micros). Null = no pricing
   * signal for a component — never invent a number.
   */
  costByLevel: Record<UpdateStaleDepth, Microdollars | null>;
};

/** Fallback clip length for video pricing when the plan carries none. */
const DEFAULT_VIDEO_DURATION_MS = 5_000;

const sum = (parts: Array<Microdollars | null>): Microdollars | null =>
  parts.reduce<Microdollars | null>(
    (acc, p) => (acc == null || p == null ? null : addMicros(acc, p)),
    ZERO_MICROS
  );

/** Add two possibly-unknown estimates; unknown poisons the total (honesty). */
const addMaybe = (
  a: Microdollars | null,
  b: Microdollars | null
): Microdollars | null => (a == null || b == null ? null : addMicros(a, b));

export function buildUpdateStalePreview(
  plan: UpdateStalePlan,
  pricing: FalPricingMap,
  musicModel: string | null
): UpdateStalePreview {
  const visual = plan.targets.filter((t) => t.regenVisual);
  const motion = plan.targets.filter((t) => t.regenMotion);
  const images = plan.targets.filter((t) => t.regenImage);
  const dialogues = plan.targets.filter((t) => t.regenDialogue);
  const videos = plan.targets.filter((t) => t.regenVideo);
  const music = plan.music;

  const promptsCost = estimateLLMCost(visual.length + motion.length);
  const imagesCost = sum(
    images.map((t) =>
      estimateImageCost(t.imageModel, plan.aspectRatio, 1, {
        pricing,
        resolution: plan.sequence.resolution,
      })
    )
  );
  const videoModel = safeImageToVideoModel(plan.sequence.videoModel);
  // Dialogue is recorded once per SCENE before the renders (#1657), so it is
  // priced per scene: the whole conversation of every scene with a voiced
  // video target. An upper bound — a scene whose clips still match its lines
  // is not recorded again.
  const dialogueCost = estimateTtsCost(
    (plan.dialogueRecording?.scenes ?? []).reduce(
      (total, job) => total + ttsCharacterCount(job.voiced),
      0
    )
  );
  const videosCost = sum(
    videos.map((t) =>
      estimateVideoCost(
        videoModel,
        (t.durationMs ?? DEFAULT_VIDEO_DURATION_MS) / 1000,
        {
          pricing,
          resolution: plan.sequence.resolution,
          referenceOnly: !t.usesStartFrame,
        }
      )
    )
  );
  const musicCost = music
    ? addMaybe(
        music.regenPrompt ? estimateLLMCost(1) : ZERO_MICROS,
        music.regenTrack
          ? estimateAudioCost(
              safeAudioModel(musicModel),
              music.durationSeconds,
              {
                pricing,
              }
            )
          : ZERO_MICROS
      )
    : ZERO_MICROS;

  return {
    visualPromptShotIds: visual.map((t) => t.shotId),
    motionPromptShotIds: motion.map((t) => t.shotId),
    imageShotIds: images.map((t) => t.shotId),
    dialogueShotIds: dialogues.map((t) => t.shotId),
    videoShotIds: videos.map((t) => t.shotId),
    musicPrompt: music?.regenPrompt ?? false,
    musicTrack: music?.regenTrack ?? false,
    costByLevel: {
      prompts: promptsCost,
      images: imagesCost,
      dialogue: dialogues.length > 0 ? dialogueCost : ZERO_MICROS,
      video: videosCost,
      music: musicCost,
    },
  };
}
