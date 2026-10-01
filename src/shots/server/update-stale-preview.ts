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
import type { AspectRatio } from '@/models/aspect-ratios';
import {
  DEFAULT_IMAGE_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type TextToImageModel,
} from '@/models/models';
import type { Resolution } from '@/models/resolutions';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import { ttsCharacterCount } from '@/motion/dialogue-tts';
import type { UpdateStaleDepth } from '@/shots/update-stale-depth';

type FalPricingMap = Record<string, EffectiveFalPricing>;

/** Fields the dry-run prices. A full `UpdateStalePlan` stays assignable. */
type UpdateStalePreviewPlan = {
  aspectRatio: AspectRatio;
  sequence: {
    videoModel: string;
    imageModel?: string | null;
    resolution?: Resolution;
  };
  targets: readonly {
    shotId: string;
    rewriteSpec?: boolean;
    regenVisual?: boolean;
    regenMotion?: boolean;
    regenImage?: boolean;
    regenDialogue?: boolean;
    regenVideo?: boolean;
    durationMs?: number | null;
    usesStartFrame?: boolean;
    imageModel: TextToImageModel;
  }[];
  music: {
    regenPrompt: boolean;
    regenTrack: boolean;
    durationSeconds: number;
  } | null;
  dialogueSpeech: {
    scenes: readonly {
      voiced: readonly { shotId: string; text: string; tone: string }[];
    }[];
  } | null;
  references?: {
    characterSheets: { length: number };
    locationSheets: { length: number };
    elementSheets?: { entries: { length: number } } | null;
  } | null;
};

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
  plan: UpdateStalePreviewPlan,
  pricing: FalPricingMap,
  musicModel: string | null
): UpdateStalePreview {
  const visual = plan.targets.filter((t) => t.regenVisual);
  const motion = plan.targets.filter((t) => t.regenMotion);
  const images = plan.targets.filter((t) => t.regenImage);
  const dialogues = plan.targets.filter((t) => t.regenDialogue);
  const videos = plan.targets.filter((t) => t.regenVideo);
  const music = plan.music;

  const rewrites = plan.targets.filter((t) => t.rewriteSpec === true);
  const promptsCost = estimateLLMCost(rewrites.length);
  const imagesCost = sum(
    images.map((t) =>
      estimateImageCost(t.imageModel, plan.aspectRatio, 1, {
        pricing,
        resolution: plan.sequence.resolution,
      })
    )
  );
  // Sheets and element references ride on the images level (#1819): a
  // stale sheet is an image, and the stills made from it wait for it.
  const references = plan.references;
  const sheetCount = references
    ? references.characterSheets.length +
      references.locationSheets.length +
      (references.elementSheets?.entries.length ?? 0)
    : 0;
  const sheetsCost =
    sheetCount > 0
      ? estimateImageCost(
          safeTextToImageModel(plan.sequence.imageModel, DEFAULT_IMAGE_MODEL),
          '16:9',
          sheetCount,
          { pricing }
        )
      : ZERO_MICROS;
  const videoModel = safeImageToVideoModel(plan.sequence.videoModel);
  // Dialogue is recorded once per SCENE before the renders (#1657), so it is
  // priced per scene: the whole conversation, on the earliest depth that needs
  // it — dialogue when a shot in the scene re-records, else video, whose
  // render records it. An upper bound — a scene whose clips still match its
  // lines is not recorded again.
  const dialogueShotIds = new Set(dialogues.map((t) => t.shotId));
  const speechChars = { dialogue: 0, video: 0 };
  for (const job of plan.dialogueSpeech?.scenes ?? []) {
    const level = job.voiced.some((line) => dialogueShotIds.has(line.shotId))
      ? 'dialogue'
      : 'video';
    speechChars[level] += ttsCharacterCount(job.voiced);
  }
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
      images: addMaybe(imagesCost, sheetsCost),
      dialogue:
        speechChars.dialogue > 0
          ? estimateTtsCost(speechChars.dialogue)
          : ZERO_MICROS,
      video:
        speechChars.video > 0
          ? addMaybe(videosCost, estimateTtsCost(speechChars.video))
          : videosCost,
      music: musicCost,
    },
  };
}
