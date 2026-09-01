/**
 * Storyboard credit pre-flight shared by create / regenerate / retry (#1140).
 *
 * Keeps UI ActionCost and server `requireCredits` on the same composition:
 * scene count (labels + optional target duration), motion only when
 * `autoGenerateMotion`, music only when motion+music are both on.
 */

import { estimateMotionDurations } from '@/lib/ai/enhance-duration';
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import {
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { estimateStoryboardCost } from '@/lib/billing/cost-estimation';
import type { Microdollars } from '@/lib/billing/money';
import { estimateSceneCount } from '@/lib/generation/time-estimate';

export type StoryboardPreflightInput = {
  script: string;
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-shot image cost). */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  autoGenerateMotion?: boolean;
  videoModels?: ImageToVideoModel[];
  autoGenerateMusic?: boolean;
  audioModels?: AudioModel[];
  /**
   * Enhance / Generate duration chip (15 / 30 / 60 / 120 / 180 / 300). Used for scene-count
   * pre-Enhance and for per-shot / music duration when motion or music is on.
   */
  targetDurationSeconds?: number;
  pricing: Record<string, EffectiveFalPricing>;
};

/**
 * Estimate storyboard cost for a credit gate, mirroring Generate's ActionCost.
 */
export function estimateStoryboardPreflightCost(
  opts: StoryboardPreflightInput
): Microdollars {
  const sceneCount = estimateSceneCount(opts.script, {
    targetDurationSeconds: opts.targetDurationSeconds,
  });

  const motionOn = Boolean(opts.autoGenerateMotion && opts.videoModels?.length);
  const musicOn = Boolean(
    motionOn && opts.autoGenerateMusic && opts.audioModels?.length
  );

  const primaryVideo = opts.videoModels?.[0] ?? DEFAULT_VIDEO_MODEL;
  const motionDurations =
    motionOn &&
    opts.targetDurationSeconds != null &&
    opts.targetDurationSeconds > 0
      ? estimateMotionDurations({
          script: opts.script,
          targetSeconds: opts.targetDurationSeconds,
          sceneCount,
          model: primaryVideo,
        })
      : undefined;

  return estimateStoryboardCost({
    imageModel: opts.imageModel,
    imageModelCount: opts.imageModelCount,
    aspectRatio: opts.aspectRatio,
    estimatedSceneCount: sceneCount,
    autoGenerateMotion: motionOn,
    videoModels: motionOn ? opts.videoModels : undefined,
    videoDurationSeconds: motionDurations?.perShotSeconds,
    autoGenerateMusic: musicOn,
    audioModels: musicOn ? opts.audioModels : undefined,
    audioDurationSeconds: musicOn
      ? (motionDurations?.totalSeconds ?? opts.targetDurationSeconds)
      : undefined,
    pricing: opts.pricing,
  });
}
