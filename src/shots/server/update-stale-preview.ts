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
import {
  DEFAULT_IMAGE_MODEL,
  safeAudioModel,
  safeTextToImageModel,
  supportsDraftMode,
} from '@/models/models';
import { resolveVideoModel } from '@/models/resolve-asset-models';
import { DRAFT_RESOLUTION } from '@/motion/draft-mode';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/billing/money';
import { ttsCharacterCount } from '@/motion/dialogue-tts';
import { estimateLipsyncCost } from '@/motion/lipsync';
import { targetRendersDraft, type UpdateStalePlan } from './update-stale-plan';
import type { UpdateStaleDepth } from '@/shots/update-stale-depth';

export type UpdateStalePreview = {
  visualPromptShotIds: string[];
  motionPromptShotIds: string[];
  imageShotIds: string[];
  dialogueShotIds: string[];
  videoShotIds: string[];
  /**
   * Shots inside `videoShotIds` whose clip is lip-synced instead of
   * re-rendered (#2263). Absent when the plan predates the field.
   */
  lipsyncShotIds?: string[];
  musicPrompt: boolean;
  musicTrack: boolean;
  /**
   * Estimated cost of each level's OWN additions (micros). Null = no pricing
   * signal for a component — never invent a number.
   */
  costByLevel: Record<UpdateStaleDepth, Microdollars | null>;
  /**
   * The draft switch for the re-rendered clips (#2424). `selected` is each
   * clip's default (a draft stays a draft); 'mixed' when they differ. Null
   * when no clip can render as an Ark draft. `costByLevel.video` is the
   * default's cost.
   */
  videoDraft: {
    selected: boolean | 'mixed';
    draftCost: Microdollars | null;
    finalCost: Microdollars | null;
  } | null;
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
  musicModel: string | null,
  /** Seedance submits to Ark for this organization (`seedanceRunsOnArk`). */
  onArk: boolean
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
      references.lookSheetsAfterDefault.length +
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
  // Each clip's model and draft default, as the run resolves them.
  const clips = videos.map((t) => {
    const model =
      plan.renderOptions?.videoModels?.[0] ??
      resolveVideoModel({
        selectedVersionModel: t.motionRender.selectedModel,
        sequenceModel: plan.sequence.videoModel,
      });
    const draftable = onArk && !t.lipsyncVideo && supportsDraftMode(model);
    return { t, model, draftable, drafts: targetRendersDraft(plan, t) };
  });
  // `draft` undefined = each clip's own default.
  const videosCost = (draft: boolean | undefined) =>
    sum(
      clips.map(({ t, model, draftable, drafts }) =>
        t.lipsyncVideo
          ? estimateLipsyncCost(
              (t.durationMs ?? DEFAULT_VIDEO_DURATION_MS) / 1000
            )
          : estimateVideoCost(
              model,
              (t.durationMs ?? DEFAULT_VIDEO_DURATION_MS) / 1000,
              {
                pricing,
                resolution:
                  draftable && (draft ?? drafts)
                    ? DRAFT_RESOLUTION
                    : plan.sequence.resolution,
                referenceOnly: !t.usesStartFrame,
              }
            )
      )
    );
  const videoLevelCost = (draft: boolean | undefined) =>
    speechChars.video > 0
      ? addMaybe(videosCost(draft), estimateTtsCost(speechChars.video))
      : videosCost(draft);
  const draftable = clips.filter((c) => c.draftable);
  const draftDefaults = new Set(draftable.map((c) => c.drafts));
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
    lipsyncShotIds: videos.filter((t) => t.lipsyncVideo).map((t) => t.shotId),
    musicPrompt: music?.regenPrompt ?? false,
    musicTrack: music?.regenTrack ?? false,
    costByLevel: {
      prompts: promptsCost,
      images: addMaybe(imagesCost, sheetsCost),
      dialogue:
        speechChars.dialogue > 0
          ? estimateTtsCost(speechChars.dialogue)
          : ZERO_MICROS,
      video: videoLevelCost(undefined),
      music: musicCost,
    },
    videoDraft:
      draftable.length > 0
        ? {
            selected:
              draftDefaults.size > 1 ? 'mixed' : draftDefaults.has(true),
            draftCost: videoLevelCost(true),
            finalCost: videoLevelCost(false),
          }
        : null,
  };
}
