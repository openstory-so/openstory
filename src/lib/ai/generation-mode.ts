/**
 * Quality vs Turbo generation mode.
 *
 * Turbo is the product default. Switching mode selects the recommended
 * (top) model in that section — it does not hide the other catalog. Pickers
 * show Fast and Quality groups, each ordered by our recommendation.
 *
 * Scene-split stays on SCENE_SPLIT_MODEL (Opus 5 Fast) regardless of mode —
 * that call is pinned in the workflow, not the composer picker.
 */
import { type AnalysisModelId } from '@/lib/ai/models.config';
import {
  DEFAULT_VIDEO_MODEL,
  getCompatibleModel,
  isValidImageToVideoModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';

const GENERATION_MODES = ['quality', 'turbo'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const DEFAULT_GENERATION_MODE: GenerationMode = 'turbo';

/** Picker section order: Fast first, then Quality. */
export const SELECTOR_GROUP_ORDER = ['fast', 'quality'] as const;
export type SelectorGroup = (typeof SELECTOR_GROUP_ORDER)[number];

/** Fast analysis models, recommendation order. Luna is the turbo default. */
export const TURBO_ANALYSIS_MODELS = [
  'openai/gpt-5.6-luna',
  'anthropic/claude-opus-5-fast',
  'google/gemini-3.7-flash',
  'z-ai/glm-5.3-flash',
] as const satisfies readonly AnalysisModelId[];

/** Fast image models that still take references. Lite is the turbo default. */
export const TURBO_IMAGE_MODELS = [
  'nano_banana_2_lite',
  'nano_banana_2',
  'flux_2_flash',
  'flux_2_turbo',
] as const satisfies readonly TextToImageModel[];

/** Fast motion models. H3 Max is the turbo default. */
export const TURBO_VIDEO_MODELS = [
  'minimax_h3_max',
  'ltx_2_3_pro',
  'minimax_hailuo_02',
  'grok_imagine_video_1_5',
] as const satisfies readonly ImageToVideoModel[];

/** Fast audio. ElevenLabs is the default in both modes. */
export const TURBO_AUDIO_MODELS = [
  'elevenlabs_music',
  'ace_step',
  'ace_step_1_5',
] as const satisfies readonly AudioModel[];

export const TURBO_DEFAULT_ANALYSIS = 'openai/gpt-5.6-luna' as const;
export const TURBO_DEFAULT_IMAGE = 'nano_banana_2_lite' as const;
export const TURBO_DEFAULT_VIDEO = 'minimax_h3_max' as const;
export const TURBO_DEFAULT_AUDIO = 'elevenlabs_music' as const;

export const QUALITY_DEFAULT_ANALYSIS = 'anthropic/claude-fable-5' as const;
export const QUALITY_DEFAULT_IMAGE = 'gpt_image_2' as const;
export const QUALITY_DEFAULT_VIDEO = 'seedance_v2' as const;
export const QUALITY_DEFAULT_AUDIO = 'elevenlabs_music' as const;

const TURBO_IMAGE_MODEL_SET = new Set<string>(TURBO_IMAGE_MODELS);
const TURBO_VIDEO_MODEL_SET = new Set<string>(TURBO_VIDEO_MODELS);

export function isTurboImageModel(model: string): boolean {
  return TURBO_IMAGE_MODEL_SET.has(model);
}

export function isTurboVideoModel(model: string): boolean {
  return TURBO_VIDEO_MODEL_SET.has(model);
}

/** Style auto-apply may set Fast models in Turbo; Quality recs stay Quality-only. */
export function styleMayApplyImage(
  mode: GenerationMode,
  model: string
): boolean {
  return mode !== 'turbo' || isTurboImageModel(model);
}

export function styleMayApplyVideo(
  mode: GenerationMode,
  model: string
): boolean {
  return mode !== 'turbo' || isTurboVideoModel(model);
}

export function isGenerationMode(value: unknown): value is GenerationMode {
  return (
    typeof value === 'string' &&
    (GENERATION_MODES as readonly string[]).includes(value)
  );
}

export function selectorGroup(
  id: string,
  fastIds: readonly string[]
): SelectorGroup {
  return fastIds.includes(id) ? 'fast' : 'quality';
}

/** Fast ids in list order, then Quality (section default first, then rank). */
export function compareSelectorModels(
  a: string,
  b: string,
  fastIds: readonly string[],
  qualityDefault: string,
  qualityRank: (id: string) => number
): number {
  const aFast = fastIds.indexOf(a);
  const bFast = fastIds.indexOf(b);
  if (aFast !== -1 && bFast !== -1) return aFast - bFast;
  if (aFast !== -1) return -1;
  if (bFast !== -1) return 1;
  if (a === qualityDefault && b !== qualityDefault) return -1;
  if (b === qualityDefault && a !== qualityDefault) return 1;
  return qualityRank(a) - qualityRank(b);
}

export function defaultAnalysisModel(mode: GenerationMode): AnalysisModelId {
  return mode === 'turbo' ? TURBO_DEFAULT_ANALYSIS : QUALITY_DEFAULT_ANALYSIS;
}

export function defaultImageModel(mode: GenerationMode): TextToImageModel {
  return mode === 'turbo' ? TURBO_DEFAULT_IMAGE : QUALITY_DEFAULT_IMAGE;
}

export function defaultVideoModel(
  mode: GenerationMode,
  aspectRatio: AspectRatio
): ImageToVideoModel {
  const preferred =
    mode === 'turbo' ? TURBO_DEFAULT_VIDEO : QUALITY_DEFAULT_VIDEO;
  return getCompatibleModel(preferred, aspectRatio);
}

function defaultAudioModel(mode: GenerationMode): AudioModel {
  return mode === 'turbo' ? TURBO_DEFAULT_AUDIO : QUALITY_DEFAULT_AUDIO;
}

function coerceVideoModels(
  selected: readonly ImageToVideoModel[],
  aspectRatio: AspectRatio
): ImageToVideoModel[] {
  const kept = [
    ...new Set(
      selected
        .filter(isValidImageToVideoModel)
        .map((m) => getCompatibleModel(m, aspectRatio))
    ),
  ];
  return kept.length > 0
    ? kept
    : [getCompatibleModel(DEFAULT_VIDEO_MODEL, aspectRatio)];
}

export type GenerationModeFields = {
  generationMode: GenerationMode;
  analysisModels: AnalysisModelId[];
  imageModels: TextToImageModel[];
  videoModels: ImageToVideoModel[];
  audioModels: AudioModel[];
  aspectRatio: AspectRatio;
};

/**
 * Switching mode snaps each catalog to that mode's recommended default.
 * Same-mode updates only coerce video for the current aspect ratio — a
 * Quality model stays selected in Turbo, and the reverse.
 */
export function applyGenerationMode<T extends GenerationModeFields>(
  settings: T,
  mode: GenerationMode
): T {
  if (settings.generationMode === mode) {
    return {
      ...settings,
      videoModels: coerceVideoModels(
        settings.videoModels,
        settings.aspectRatio
      ),
    };
  }
  return {
    ...settings,
    generationMode: mode,
    analysisModels: [defaultAnalysisModel(mode)],
    imageModels: [defaultImageModel(mode)],
    videoModels: [defaultVideoModel(mode, settings.aspectRatio)],
    audioModels: [defaultAudioModel(mode)],
  };
}
