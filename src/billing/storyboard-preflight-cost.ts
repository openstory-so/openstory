/**
 * Storyboard credit pre-flight shared by create / regenerate / retry (#1140).
 *
 * Keeps UI ActionCost and server `requireCredits` on the same composition:
 * scene count (labels + optional target duration), motion only when
 * `autoGenerateMotion`, music only when motion+music are both on.
 */

import {
  assessDurationFit,
  estimateMotionDurations,
} from '@/models/enhance-duration';
import { durationGridForModel, snapDuration } from '@/motion/snap-duration';
import { estimateSecondsFromText } from '@/sequences/scene-from-slice';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  DEFAULT_VIDEO_MODEL,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { estimateStoryboardCost } from './cost-estimation';
import type { Microdollars } from './money';
import { estimateSceneCount } from '@/sequences/time-estimate';
import { shouldRunStage, type GenerationStage } from '@/sequences/pipeline';

export type StoryboardPreflightInput = {
  script: string;
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-shot image cost). */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  /** Output resolution tier (#1449) — sizes the stills and clips being gated. */
  resolution?: Resolution;
  autoGenerateMotion?: boolean;
  stopAt?: GenerationStage;
  /** Continue-from: stages before this already ran and are not gated (#1408). */
  startFrom?: GenerationStage;
  videoModels?: ImageToVideoModel[];
  autoGenerateMusic?: boolean;
  audioModels?: AudioModel[];
  /** Renders straight to video — no shot stills to bill. */
  referenceOnly?: boolean;
  /** One Voice Design call per estimated character (#1553). */
  generateVoices?: boolean;
  /**
   * The Enhance target when Enhance ran (#1593). Without it the script's own
   * length is used: its labels, else its text at three words a second.
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
  const primaryVideo = opts.videoModels?.[0] ?? DEFAULT_VIDEO_MODEL;
  // How long the script plays: the Enhance target when Enhance ran, else its
  // labels, else the text at three words a second — the rule the scene split
  // applies to an unlabelled scene (#1593).
  const labeledSeconds = assessDurationFit(
    opts.script,
    primaryVideo
  ).snappedSeconds;
  const scriptSeconds =
    opts.targetDurationSeconds ??
    labeledSeconds ??
    estimateSecondsFromText(opts.script);
  // Shots to bill. Labelled scripts count their headings. An unlabelled one
  // holds at least one typical clip (the grid's middle length) per its
  // playing time — a 90-minute paste is hundreds of shots, not 30.
  const headingCount = estimateSceneCount(opts.script, {
    targetDurationSeconds: opts.targetDurationSeconds,
  });
  const grid = durationGridForModel(primaryVideo);
  const typicalClip = snapDuration(
    grid[Math.floor(grid.length / 2)],
    primaryVideo
  );
  const sceneCount =
    opts.targetDurationSeconds == null && labeledSeconds == null
      ? Math.max(headingCount, Math.ceil(scriptSeconds / typicalClip))
      : headingCount;

  const startFrom = opts.startFrom ?? 'script';
  const motionOn = opts.stopAt
    ? shouldRunStage(startFrom, opts.stopAt, 'motion') &&
      Boolean(opts.videoModels?.length)
    : Boolean(opts.autoGenerateMotion && opts.videoModels?.length);
  const musicOn = opts.stopAt
    ? shouldRunStage(startFrom, opts.stopAt, 'music') &&
      Boolean(opts.audioModels?.length)
    : Boolean(motionOn && opts.autoGenerateMusic && opts.audioModels?.length);

  const motionDurations = motionOn
    ? estimateMotionDurations({
        script: opts.script,
        targetSeconds: scriptSeconds,
        sceneCount,
        model: primaryVideo,
      })
    : undefined;

  return estimateStoryboardCost({
    imageModel: opts.imageModel,
    imageModelCount: opts.imageModelCount,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution,
    estimatedSceneCount: sceneCount,
    autoGenerateMotion: motionOn,
    stopAt: opts.stopAt,
    startFrom: opts.startFrom,
    videoModels: motionOn ? opts.videoModels : undefined,
    videoDurationSeconds: motionDurations?.perShotSeconds,
    autoGenerateMusic: musicOn,
    referenceOnly: opts.referenceOnly,
    generateVoices: opts.generateVoices,
    audioModels: musicOn ? opts.audioModels : undefined,
    audioDurationSeconds: musicOn
      ? (motionDurations?.totalSeconds ?? scriptSeconds)
      : undefined,
    pricing: opts.pricing,
  });
}
