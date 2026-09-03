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
} from '@/lib/billing/cost-estimation';
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';

type FalPricingMap = Record<string, EffectiveFalPricing>;
import { safeAudioModel, safeImageToVideoModel } from '@/lib/ai/models';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import type { UpdateStalePlan } from '@/lib/shots/update-stale-plan';
import type { UpdateStaleDepth } from '@/lib/shots/update-stale-depth';

export type UpdateStalePreview = {
  visualPromptShotIds: string[];
  motionPromptShotIds: string[];
  imageShotIds: string[];
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
    videoShotIds: videos.map((t) => t.shotId),
    musicPrompt: music?.regenPrompt ?? false,
    musicTrack: music?.regenTrack ?? false,
    costByLevel: {
      prompts: promptsCost,
      images: imagesCost,
      video: videosCost,
      music: musicCost,
    },
  };
}
