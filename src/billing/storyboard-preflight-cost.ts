/**
 * Storyboard credit pre-flight shared by create / regenerate / retry (#1140).
 *
 * Keeps UI ActionCost and server `requireCredits` on the same composition:
 * shot count (clip labels, else headings, else playing time / typical clip),
 * motion only when `autoGenerateMotion`, music only when motion+music are both
 * on. `estimatedSceneCount` is shot stills/clips, not narrative scenes (#1593).
 */

import {
  assessDurationFit,
  estimateMotionDurations,
  parseClipDurationLabels,
} from '@/models/enhance-duration';
import { durationGridForModel } from '@/motion/snap-duration';
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
   * Values below 5s are treated as auto (same floor as the chip).
   */
  targetDurationSeconds?: number;
  /**
   * Known shot count from continue (`shots.listBySequence`). Wins over
   * script heuristics so a multi-shot board is billed as N clips, not 1
   * heading. In-run grow uses `estimateStoryboardRenderCost.estimatedSceneCount`
   * instead.
   */
  shotCount?: number;
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
  // 0 / 1–4 are not auto in JS (`??` keeps them) but they are not a legal
  // chip value either. Treat anything under the 5s floor as auto.
  const targetSeconds =
    opts.targetDurationSeconds != null && opts.targetDurationSeconds >= 5
      ? opts.targetDurationSeconds
      : undefined;
  const scriptSeconds =
    targetSeconds ?? labeledSeconds ?? estimateSecondsFromText(opts.script);
  // Shots to bill. A known count from continue wins. Else per-scene clip
  // labels (`Shot N — Xs` in that scene, else `Scene N — Xs`). An unlabelled
  // paste holds at least one typical clip per its playing time — a 90-minute
  // script is hundreds of shots, not 30 headings.
  const headingCount = estimateSceneCount(opts.script, {
    targetDurationSeconds: targetSeconds,
  });
  const grid = durationGridForModel(primaryVideo);
  const typicalClip = grid[Math.floor(grid.length / 2)] ?? 5;
  const clipCount = parseClipDurationLabels(opts.script).length;
  let sceneCount: number;
  if (opts.shotCount != null && opts.shotCount > 0) {
    sceneCount = opts.shotCount;
  } else if (clipCount > 0) {
    sceneCount = clipCount;
  } else if (targetSeconds == null && labeledSeconds == null) {
    sceneCount = Math.max(headingCount, Math.ceil(scriptSeconds / typicalClip));
  } else {
    sceneCount = headingCount;
  }

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
