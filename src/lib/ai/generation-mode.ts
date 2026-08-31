/**
 * Quality vs Turbo generation mode.
 *
 * Turbo is the product default: fastest models that still completed our
 * analysis/image/motion evals. Quality restores the full catalogs and
 * quality-ranked defaults (GPT Image 2, Seedance, Fable in the picker).
 *
 * Scene-split stays on SCENE_SPLIT_MODEL (Opus 5 Fast) regardless of mode —
 * that call is pinned in the workflow, not the composer picker.
 */
import {
  DEFAULT_ANALYSIS_MODEL,
  isSelectableAnalysisModelId,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import {
  getCompatibleModel,
  isModelCompatibleWithAspectRatio,
  isValidAudioModel,
  isValidTextToImageModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';

const GENERATION_MODES = ['quality', 'turbo'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const DEFAULT_GENERATION_MODE: GenerationMode = 'turbo';

/** Fastest analysis models that finished the pipeline eval with vision. */
export const TURBO_ANALYSIS_MODELS = [
  'openai/gpt-5.6-luna',
  'anthropic/claude-opus-5-fast',
  'google/gemini-3.7-flash',
  'z-ai/glm-5.3-flash',
] as const satisfies readonly AnalysisModelId[];

/** Fastest image models that still take references. Lite is the turbo default. */
export const TURBO_IMAGE_MODELS = [
  'nano_banana_2_lite',
  'nano_banana_2',
  'flux_2_flash',
  'flux_2_turbo',
] as const satisfies readonly TextToImageModel[];

/** Fastest motion models. H3 Max is the turbo default. */
export const TURBO_VIDEO_MODELS = [
  'minimax_h3_max',
  'ltx_2_3_pro',
  'minimax_hailuo_02',
  'grok_imagine_video_1_5',
] as const satisfies readonly ImageToVideoModel[];

/** ElevenLabs stays the default; ACE-Step is available as a faster option. */
export const TURBO_AUDIO_MODELS = [
  'elevenlabs_music',
  'ace_step',
  'ace_step_1_5',
] as const satisfies readonly AudioModel[];

export const TURBO_DEFAULT_ANALYSIS = 'openai/gpt-5.6-luna' as const;
export const TURBO_DEFAULT_IMAGE = 'nano_banana_2_lite' as const;
export const TURBO_DEFAULT_VIDEO = 'minimax_h3_max' as const;
export const TURBO_DEFAULT_AUDIO = 'elevenlabs_music' as const;

export function isGenerationMode(value: unknown): value is GenerationMode {
  return (
    typeof value === 'string' &&
    (GENERATION_MODES as readonly string[]).includes(value)
  );
}

function constrainList<T extends string>(
  selected: readonly string[],
  allowed: readonly T[],
  fallback: T
): T[] {
  const allowedSet = new Set<string>(allowed);
  const kept = selected.filter((id): id is T => allowedSet.has(id));
  return kept.length > 0 ? kept : [fallback];
}

export function constrainAnalysisModels(
  mode: GenerationMode,
  selected: readonly AnalysisModelId[]
): AnalysisModelId[] {
  if (mode === 'quality') {
    const kept = selected.filter(isSelectableAnalysisModelId);
    return kept.length > 0 ? kept : [DEFAULT_ANALYSIS_MODEL];
  }
  return constrainList(selected, TURBO_ANALYSIS_MODELS, TURBO_DEFAULT_ANALYSIS);
}

export function constrainImageModels(
  mode: GenerationMode,
  selected: readonly TextToImageModel[]
): TextToImageModel[] {
  if (mode === 'quality') {
    const kept = selected.filter(isValidTextToImageModel);
    return kept.length > 0 ? kept : ['gpt_image_2'];
  }
  return constrainList(selected, TURBO_IMAGE_MODELS, TURBO_DEFAULT_IMAGE);
}

export function constrainVideoModels(
  mode: GenerationMode,
  selected: readonly ImageToVideoModel[],
  aspectRatio: AspectRatio
): ImageToVideoModel[] {
  if (mode === 'quality') {
    const kept = selected.map((m) => getCompatibleModel(m, aspectRatio));
    return [...new Set(kept)];
  }
  type TurboVideo = (typeof TURBO_VIDEO_MODELS)[number];
  const allowed: TurboVideo[] = TURBO_VIDEO_MODELS.filter((m) =>
    isModelCompatibleWithAspectRatio(m, aspectRatio)
  );
  const first = allowed[0];
  if (!first) {
    return [getCompatibleModel(TURBO_DEFAULT_VIDEO, aspectRatio)];
  }
  const fallback = allowed.includes(TURBO_DEFAULT_VIDEO)
    ? TURBO_DEFAULT_VIDEO
    : first;
  return constrainList(selected, allowed, fallback);
}

export function constrainAudioModels(
  mode: GenerationMode,
  selected: readonly AudioModel[]
): AudioModel[] {
  if (mode === 'quality') {
    const kept = selected.filter(isValidAudioModel);
    return kept.length > 0 ? kept : ['elevenlabs_music'];
  }
  return constrainList(selected, TURBO_AUDIO_MODELS, TURBO_DEFAULT_AUDIO);
}

export type GenerationModeFields = {
  generationMode: GenerationMode;
  analysisModels: AnalysisModelId[];
  imageModels: TextToImageModel[];
  videoModels: ImageToVideoModel[];
  audioModels: AudioModel[];
  aspectRatio: AspectRatio;
};

export function applyGenerationMode<T extends GenerationModeFields>(
  settings: T,
  mode: GenerationMode
): T {
  return {
    ...settings,
    generationMode: mode,
    analysisModels: constrainAnalysisModels(mode, settings.analysisModels),
    imageModels: constrainImageModels(mode, settings.imageModels),
    videoModels: constrainVideoModels(
      mode,
      settings.videoModels,
      settings.aspectRatio
    ),
    audioModels: constrainAudioModels(mode, settings.audioModels),
  };
}
