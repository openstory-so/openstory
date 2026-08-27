/**
 * FAL AI model definitions
 * Separated to avoid circular dependencies between service and client modules
 */

import type { AnalysisModelId } from '@/lib/ai/models.config';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { MOTION_INPUT_SCHEMAS } from '@/lib/motion/endpoint-map';
// Type-only: the Seedream adapter narrows `model` to a literal union, so the
// catalog's `byteplusId` has to be that union rather than a bare string —
// a retired id then fails typecheck instead of at request time (#1157).
import type { BytePlusImageModel } from '@tanstack/ai-byteplus';
import { z } from 'zod';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'models']);

// ============================================================================
// Text (Chat/LLM) Models — OpenRouter
// ============================================================================

/**
 * Valid text model IDs for OpenRouter chat/LLM calls.
 * Derived from our curated SCRIPT_ANALYSIS_MODELS list in models.config.ts.
 * (The @tanstack/ai-openrouter adapter's built-in model list is stale.)
 */
export type TextModel = AnalysisModelId;

/**
 * Image-to-video models (for motion generation)
 *
 * API-contract details (durations, aspect ratios, image URL field names) are
 * derived from OpenAPI schemas — see MOTION_ENDPOINT_META and MOTION_TRANSFORMS
 * in src/lib/motion/generated/endpoint-map.ts.
 *
 * Only model-level metadata lives here: identity, audio override, performance.
 */
export const IMAGE_TO_VIDEO_MODELS = {
  grok_imagine_video_1_5: {
    id: 'xai/grok-imagine-video/v1.5/image-to-video',
    name: 'Grok Imagine Video 1.5',
    vendor: 'SpaceXAI',
    license: 'proprietary' as const,
    qualityRank: 1,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
  },
  ltx_2_3_pro: {
    id: 'fal-ai/ltx-2.3/image-to-video',
    name: 'LTX 2.3 Pro',
    vendor: 'Lightricks',
    license: 'open-source' as const,
    qualityRank: 2,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 15, quality: 'best' as const },
  },
  veo3_1: {
    id: 'fal-ai/veo3.1/image-to-video',
    name: 'Veo 3.1',
    vendor: 'Google',
    license: 'proprietary' as const,
    qualityRank: 2,
    maxPromptLength: 20000,
    performance: { estimatedGenerationTime: 25, quality: 'best' as const },
  },
  kling_v3_pro: {
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    name: 'Kling v3 Pro',
    vendor: 'Kling',
    license: 'proprietary' as const,
    qualityRank: 3,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
  },
  minimax_hailuo_02: {
    id: 'fal-ai/minimax/hailuo-2.3/pro/image-to-video',
    name: 'MiniMax Hailuo 2.3',
    vendor: 'MiniMax',
    license: 'proprietary' as const,
    qualityRank: 5,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 15, quality: 'best' as const },
  },
  minimax_h3_max: {
    id: 'minimax/h3-max/image-to-video',
    name: 'MiniMax H3 Max',
    vendor: 'MiniMax',
    license: 'proprietary' as const,
    qualityRank: 4,
    // Always generates audio (lip-synced dialogue, ambience, score) with no
    // API switch — the schema has no generate_audio, so the builder must
    // direct it in-prompt. See buildMinimaxH3Prompt.
    supportsAudio: true,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 15, quality: 'best' as const },
  },
  seedance_v2: {
    id: 'bytedance/seedance-2.0/enterprise/v2/image-to-video',
    name: 'Seedance 2.0',
    vendor: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 4,
    maxPromptLength: 4096,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
  },
  seedance_v2_5: {
    id: 'bytedance/seedance-2.5/image-to-video',
    name: 'Seedance 2.5',
    vendor: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 2,
    maxPromptLength: 4096,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
    // Hidden from sequence/studio pickers: public fal 2.5 400s photoreal
    // faces without Ark `asset://` ingest, and we are not rolling Ark out.
    // Catalog key stays so a later Ark enablement does not need a rename.
    hidden: true,
    // Native BytePlus Ark route (#1157). Must be activated in the Ark console
    // first — an unopened model answers 404 ModelNotOpen at request time. The
    // Ark route requests 720p (see BYTEPLUS_RESOLUTION); the rate card's
    // $10.70/1M-token entry is exact for that tier only. fal has no
    // enterprise 2.5 (those paths 404); public 2.5 is the fal via.
    byteplusId: 'dreamina-seedance-2-5-260628' as const,
  },
} as const;

/**
 * Available models for image generation with rich metadata
 */
export const IMAGE_MODELS = {
  nano_banana_2: {
    id: 'fal-ai/nano-banana-2' as const,
    name: 'Nano Banana 2',
    vendor: 'Google',
    license: 'proprietary' as const,
    qualityRank: 1,
    description: "Google's latest fast image generation and editing model",
    maxPromptLength: 50000,
  },
  nano_banana_pro: {
    id: 'fal-ai/nano-banana-pro' as const,
    name: 'Nano Banana Pro',
    vendor: 'Google',
    license: 'proprietary' as const,
    qualityRank: 2,
    description: 'Enhanced realism and typography',
    maxPromptLength: 50000,
  },
  gpt_image_2: {
    id: 'openai/gpt-image-2' as const,
    name: 'GPT Image 2',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    qualityRank: 2,
    description: 'Near-perfect text rendering, UI fidelity, up to 4K',
    maxPromptLength: 32000,
  },
  grok_imagine_image: {
    id: 'xai/grok-imagine-image/v2.0/text-to-image' as const,
    name: 'Grok Imagine Image 2.0',
    vendor: 'SpaceXAI',
    license: 'proprietary' as const,
    qualityRank: 3,
    description:
      'Newest Imagine image model — 1K/2K, quality medium, edit up to 3 refs',
    maxPromptLength: 4000,
  },
  grok_imagine_image_quality: {
    id: 'xai/grok-imagine-image/quality/text-to-image' as const,
    name: 'Grok Imagine Image Quality',
    vendor: 'SpaceXAI',
    license: 'proprietary' as const,
    qualityRank: 3,
    description:
      'Quality Mode — higher fidelity and stronger text rendering, edit up to 3 refs',
    maxPromptLength: 4000,
  },
  flux_2_max: {
    id: 'fal-ai/flux-2-max' as const,
    name: 'FLUX.2 Max',
    vendor: 'Black Forest Labs',
    license: 'proprietary' as const,
    qualityRank: 4,
    description: 'Exceptional realism, precision, and consistency',
    maxPromptLength: 2000,
  },
  phota: {
    id: 'fal-ai/phota' as const,
    name: 'Phota',
    vendor: 'Phota',
    license: 'proprietary' as const,
    qualityRank: 5,
    description: 'Character consistency via profiles',
    maxPromptLength: 8000,
  },
  hunyuan_image_v3: {
    id: 'fal-ai/hunyuan-image/v3/text-to-image' as const,
    name: 'Hunyuan Image v3',
    vendor: 'Tencent',
    license: 'open-source' as const,
    qualityRank: 6,
    description: 'Open source with strong composition',
    maxPromptLength: 2000,
  },
  flux_2_dev: {
    id: 'fal-ai/flux-2' as const,
    name: 'FLUX.2 Dev',
    vendor: 'Black Forest Labs',
    license: 'open-source' as const,
    qualityRank: 7,
    description: '32B open weights with native editing',
    maxPromptLength: 2000,
  },
  qwen_image: {
    id: 'fal-ai/qwen-image-2/pro/text-to-image' as const,
    name: 'Qwen Image 2 Pro',
    vendor: 'Alibaba',
    license: 'open-source' as const,
    qualityRank: 8,
    description: 'Apache 2.0, native 2K, text rendering, editing support',
    maxPromptLength: 2000,
  },
  hidream_i1: {
    id: 'fal-ai/hidream-i1-full' as const,
    name: 'HiDream I1',
    vendor: 'HiDream',
    license: 'open-source' as const,
    qualityRank: 9,
    description: 'MIT licensed, 17B parameters',
    maxPromptLength: 2000,
  },
  seedream_v5: {
    id: 'bytedance/seedream/v5/pro/text-to-image' as const,
    name: 'Seedream 5.0 Pro',
    vendor: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 10,
    description:
      'Flagship generation and editing — dense layouts, native text, up to 10 refs',
    maxPromptLength: 2000,
    // Native BytePlus Ark route (#1157). Ark carries reference images inline
    // on the generation call, so this route has no separate edit endpoint —
    // see EDIT_ENDPOINTS, which stays fal-only. Pro, not lite:
    // dola-seedream-5-0-pro-260628. Lite is seedream-5-0-260128.
    byteplusId: 'dola-seedream-5-0-pro-260628' as const,
  },
  flux_2_turbo: {
    id: 'fal-ai/flux-2/turbo' as const,
    name: 'FLUX.2 Turbo',
    vendor: 'Black Forest Labs',
    license: 'open-source' as const,
    qualityRank: 99,
    description: 'Ultra-fast preview generation',
    maxPromptLength: 2000,
    hidden: true,
  },
  krea_2_turbo: {
    id: 'fal-ai/krea-2/turbo' as const,
    name: 'Krea 2 Turbo',
    vendor: 'Krea',
    license: 'open-source' as const,
    qualityRank: 99,
    description: 'Ultra-fast storyboard generation',
    maxPromptLength: 2000,
    hidden: true,
  },
} as const;

// Text to image model types
export type TextToImageModel = keyof typeof IMAGE_MODELS;
type ImageModelConfig = (typeof IMAGE_MODELS)[TextToImageModel];
type TextToImageModelId = ImageModelConfig['id'];

export const DEFAULT_IMAGE_MODEL: TextToImageModel = 'gpt_image_2';

/** Model used for fast preview image generation. flux_2_turbo stays in the
 *  registry because stored preview variants still reference it. */
export const PREVIEW_IMAGE_MODEL: TextToImageModel = 'krea_2_turbo';

// Helper to get model ID from key
export function getTextToImageModelId(
  modelKey: TextToImageModel
): TextToImageModelId {
  return IMAGE_MODELS[modelKey].id;
}

// Helper to get model config by ID
export function getImageModelById(id: string): ImageModelConfig | undefined {
  return Object.values(IMAGE_MODELS).find((model) => model.id === id);
}

/**
 * The BytePlus Ark model id for a text-to-image model, or undefined when the
 * model has no native Ark route and always goes through fal (#1157).
 */
export function getBytePlusImageModelId(
  modelKey: TextToImageModel
): BytePlusImageModel | undefined {
  const config = IMAGE_MODELS[modelKey];
  return 'byteplusId' in config ? config.byteplusId : undefined;
}

export function isNativeBytePlusImageModel(model: TextToImageModel): boolean {
  return getBytePlusImageModelId(model) !== undefined;
}

// Image to video model types
export type ImageToVideoModel = keyof typeof IMAGE_TO_VIDEO_MODELS;

/**
 * The BytePlus Ark model id for a motion model, or undefined when the model
 * has no native Ark route and always goes through fal (#1157).
 */
export function getBytePlusVideoModelId(
  modelKey: ImageToVideoModel
): string | undefined {
  const config = IMAGE_TO_VIDEO_MODELS[modelKey];
  return 'byteplusId' in config ? config.byteplusId : undefined;
}

export function isNativeBytePlusVideoModel(model: ImageToVideoModel): boolean {
  return getBytePlusVideoModelId(model) !== undefined;
}

export const DEFAULT_VIDEO_MODEL: ImageToVideoModel = 'seedance_v2';

function schemaOf(modelKey: ImageToVideoModel) {
  return MOTION_INPUT_SCHEMAS[IMAGE_TO_VIDEO_MODELS[modelKey].id];
}

/** Check if a video model supports audio output.
 *  Checks the Zod schema for a generate_audio field, respects per-model overrides. */
export function videoModelSupportsAudio(modelKey: ImageToVideoModel): boolean {
  const config = IMAGE_TO_VIDEO_MODELS[modelKey];
  if ('supportsAudio' in config && typeof config.supportsAudio === 'boolean')
    return config.supportsAudio;
  return 'generate_audio' in schemaOf(modelKey).shape;
}

/**
 * Runtime validation: Check if a string is a valid TextToImageModel key
 * @param value - String value to validate
 * @returns true if value is a valid model key, false otherwise
 */
export function isValidTextToImageModel(
  value: unknown
): value is TextToImageModel {
  return typeof value === 'string' && Object.keys(IMAGE_MODELS).includes(value);
}

/**
 * Runtime validation: Check if a string is a valid ImageToVideoModel key
 * @param value - String value to validate
 * @returns true if value is a valid model key, false otherwise
 */
export function isValidImageToVideoModel(
  value: unknown
): value is ImageToVideoModel {
  return (
    typeof value === 'string' &&
    Object.keys(IMAGE_TO_VIDEO_MODELS).includes(value)
  );
}

/**
 * Friendly display name for a video model id ("Kling v3 Pro"); returns the raw
 * id for an unrecognized (e.g. retired) model rather than hiding it.
 */
export function videoModelDisplayName(model: string): string {
  return isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model].name
    : model;
}

/**
 * Safely cast database string to TextToImageModel with validation
 * Falls back to default if invalid
 * @param value - Database string value (potentially invalid)
 * @param fallback - Default value to use if invalid (defaults to DEFAULT_IMAGE_MODEL)
 * @returns Valid TextToImageModel
 */
export function safeTextToImageModel(
  value: string | null | undefined,
  fallback: TextToImageModel = DEFAULT_IMAGE_MODEL
): TextToImageModel {
  if (!value || !isValidTextToImageModel(value)) {
    if (value) {
      logger.warn(
        `Invalid TextToImageModel "${value}", using fallback "${fallback}"`
      );
    }
    return fallback;
  }
  return value;
}

/**
 * Safely cast database string to ImageToVideoModel with validation
 * Falls back to default if invalid
 * @param value - Database string value (potentially invalid)
 * @param fallback - Default value to use if invalid (defaults to DEFAULT_VIDEO_MODEL)
 * @returns Valid ImageToVideoModel
 */
export function safeImageToVideoModel(
  value: string | null | undefined,
  fallback: ImageToVideoModel = DEFAULT_VIDEO_MODEL
): ImageToVideoModel {
  if (!value || !isValidImageToVideoModel(value)) {
    if (value) {
      logger.warn(
        `Invalid ImageToVideoModel "${value}", using fallback "${fallback}"`
      );
    }
    return fallback;
  }
  return value;
}

/**
 * Check if a video model supports a specific aspect ratio
 * @param model - The video model key to check
 * @param aspectRatio - The aspect ratio to check for
 * @returns true if the model supports the aspect ratio
 */
export function isModelCompatibleWithAspectRatio(
  model: ImageToVideoModel,
  aspectRatio: AspectRatio
): boolean {
  const schema = schemaOf(model);
  if (!('aspect_ratio' in schema.shape)) return true;
  return z
    .object({ aspect_ratio: schema.shape.aspect_ratio })
    .safeParse({ aspect_ratio: aspectRatio }).success;
}

/**
 * Get all video models that support a specific aspect ratio
 * @param aspectRatio - The aspect ratio to filter by
 * @returns Array of compatible model keys
 */
function getModelsForAspectRatio(
  aspectRatio: AspectRatio
): ImageToVideoModel[] {
  return Object.keys(IMAGE_TO_VIDEO_MODELS).filter(
    (key): key is ImageToVideoModel =>
      isValidImageToVideoModel(key) &&
      !('hidden' in IMAGE_TO_VIDEO_MODELS[key]) &&
      isModelCompatibleWithAspectRatio(key, aspectRatio)
  );
}

/**
 * Get a compatible video model for an aspect ratio, falling back if needed
 * @param currentModel - The currently selected model
 * @param aspectRatio - The target aspect ratio
 * @returns The current model if compatible, otherwise a compatible fallback
 */
export function getCompatibleModel(
  currentModel: ImageToVideoModel,
  aspectRatio: AspectRatio
): ImageToVideoModel {
  if (isModelCompatibleWithAspectRatio(currentModel, aspectRatio)) {
    return currentModel;
  }
  // Try default first
  if (isModelCompatibleWithAspectRatio(DEFAULT_VIDEO_MODEL, aspectRatio)) {
    return DEFAULT_VIDEO_MODEL;
  }
  // Fall back to first compatible model
  const compatible = getModelsForAspectRatio(aspectRatio);
  return compatible[0] ?? DEFAULT_VIDEO_MODEL;
}

// ============================================================================
// Audio/Music Generation Models
// ============================================================================

/**
 * Audio/music generation models
 * Used for generating background music and sound effects per scene
 */
export const AUDIO_MODELS = {
  elevenlabs_music: {
    id: 'fal-ai/elevenlabs/music' as const,
    name: 'ElevenLabs Music',
    vendor: 'ElevenLabs',
    license: 'proprietary' as const,
    qualityRank: 1,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsInstrumental: true,
      maxDuration: 600,
      defaultDuration: 60,
      supportedFormats: ['mp3'],
    },
    performance: {
      estimatedGenerationTime: 30,
      quality: 'best',
    },
  },
  ace_step_1_5: {
    id: 'fal-ai/ace-step-1.5' as const,
    name: 'ACE-Step 1.5',
    vendor: 'ACE Studio',
    license: 'open-source' as const,
    qualityRank: 2,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsLyrics: true,
      supportsInstrumental: true,
      maxDuration: 600,
      defaultDuration: 60,
      supportedFormats: ['wav'],
    },
    performance: {
      estimatedGenerationTime: 25,
      quality: 'best',
    },
  },
  ace_step: {
    id: 'fal-ai/ace-step/prompt-to-audio' as const,
    name: 'ACE-Step',
    vendor: 'ACE Studio',
    license: 'open-source' as const,
    qualityRank: 3,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsLyrics: true,
      supportsInstrumental: true,
      maxDuration: 240,
      defaultDuration: 60,
      supportedFormats: ['wav'],
    },
    performance: {
      estimatedGenerationTime: 20,
      quality: 'best',
    },
  },
} as const;

// Audio model types
export type AudioModel = keyof typeof AUDIO_MODELS;
export type AudioModelConfig = (typeof AUDIO_MODELS)[AudioModel];

export const DEFAULT_MUSIC_MODEL: AudioModel = 'elevenlabs_music';

export function isValidAudioModel(value: unknown): value is AudioModel {
  return typeof value === 'string' && Object.keys(AUDIO_MODELS).includes(value);
}

export function getAudioModelDurationLimits(model: AudioModel) {
  const config = AUDIO_MODELS[model];
  return {
    max: config.capabilities.maxDuration,
    default: config.capabilities.defaultDuration,
  };
}

export function safeAudioModel(
  value: string | null | undefined,
  fallback: AudioModel = DEFAULT_MUSIC_MODEL
): AudioModel {
  if (!value || !isValidAudioModel(value)) {
    if (value) {
      logger.warn(
        `Invalid AudioModel "${value}", using fallback "${fallback}"`
      );
    }
    return fallback;
  }
  return value;
}

// ============================================================================
// Edit Endpoint Support (for reference image generation)
// ============================================================================

/**
 * Map text-to-image models to their edit endpoints (if available)
 * These endpoints accept image_urls for reference-based generation
 */
export const EDIT_ENDPOINTS: Partial<Record<TextToImageModel, string>> = {
  nano_banana_2: 'fal-ai/nano-banana-2/edit',
  nano_banana_pro: 'fal-ai/nano-banana-pro/edit',
  gpt_image_2: 'openai/gpt-image-2/edit',
  grok_imagine_image: 'xai/grok-imagine-image/v2.0/edit',
  grok_imagine_image_quality: 'xai/grok-imagine-image/quality/edit',
  flux_2_max: 'fal-ai/flux-2-max/edit',
  phota: 'fal-ai/phota/edit',
  hunyuan_image_v3: 'fal-ai/hunyuan-image/v3/instruct/edit',
  flux_2_dev: 'fal-ai/flux-2/edit',
  flux_2_turbo: 'fal-ai/flux-2/turbo/edit',
  qwen_image: 'fal-ai/qwen-image-2/pro/edit',
  seedream_v5: 'bytedance/seedream/v5/pro/edit',
};

/**
 * Per-model ceiling on `image_urls` for the edit endpoints above.
 *
 * fal enforces these server-side and REJECTS the request over the limit — it
 * does not truncate, despite flux-2/turbo/edit's own schema claiming "if more
 * are provided, only the first 4 will be used". A scene with a couple of
 * characters in a location plus props clears 4 easily, so an uncapped send
 * fails the shot outright ("Number of image URLs must be less than or equal
 * to 4" — 11 of them in the #1143 load test).
 *
 * Absent = no known cap; send what we have.
 */
const EDIT_REFERENCE_LIMITS: Partial<Record<TextToImageModel, number>> = {
  flux_2_dev: 4,
  flux_2_turbo: 4,
  grok_imagine_image: 3,
  grok_imagine_image_quality: 3,
  // Seedream 5.0 Pro: 10 on fal edit and on Ark. Lite was 14.
  seedream_v5: 10,
};

/**
 * Trim reference images to what `model`'s edit endpoint accepts. References
 * are ordered characters → locations → elements, so truncation drops the
 * least identity-critical ones last.
 */
export function capReferenceImages<T>(
  model: TextToImageModel,
  references: T[]
): T[] {
  const limit = EDIT_REFERENCE_LIMITS[model];
  return limit === undefined ? references : references.slice(0, limit);
}

/**
 * Get the edit endpoint for a model that supports reference images
 * @param model - The text-to-image model key
 * @returns The Fal.ai edit endpoint ID, or null if not supported
 */
export function getEditEndpoint(model: TextToImageModel): string | null {
  return EDIT_ENDPOINTS[model] ?? null;
}

/**
 * How a model's dedicated reference-to-video endpoint binds reference images
 * to the prompt (#873). The tag syntax is per-model prompt convention, not
 * API surface — fal never validates it, the model just reads the tokens.
 */
export type MotionReferenceEndpointConfig = {
  /** The fal reference-to-video endpoint id to submit to. */
  endpointId: string;
  /**
   * Renders the prompt token bound to `image_urls[position - 1]` (position is
   * 1-based) — e.g. `@Image1` for Seedance, `<IMAGE_REF_0>` for Gemini Omni
   * Flash.
   */
  tag: (position: number) => string;
  /** Total images the endpoint accepts, including the rendered still. */
  maxImages: number;
};

/**
 * Map image-to-video models to a SEPARATE reference-to-video endpoint (#873).
 *
 * Some motion models accept cast/element reference images only on a dedicated
 * endpoint that takes `image_urls[]` (bound to prompt tokens — see
 * `MotionReferenceEndpointConfig.tag`) and has NO single start-frame
 * `image_url`. This is the motion analogue of `EDIT_ENDPOINTS` on the image
 * side: when a scene has references AND the model is listed here, motion
 * routes to this endpoint and passes the rendered still as the first image
 * plus cast/element refs after it (see `resolveMotionEndpoint`). Models that
 * emit references inline on their normal endpoint (e.g. Kling v3 Pro's
 * `elements` field) are NOT listed here.
 */
export const MOTION_REFERENCE_ENDPOINTS: Partial<
  Record<ImageToVideoModel, MotionReferenceEndpointConfig>
> = {
  seedance_v2: {
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/reference-to-video',
    tag: (position) => `@Image${position}`,
    maxImages: 9,
  },
  seedance_v2_5: {
    endpointId: 'bytedance/seedance-2.5/reference-to-video',
    tag: (position) => `@Image${position}`,
    maxImages: 9,
  },
};

/**
 * Models that attach reference images on the normal image-to-video endpoint
 * (Kling's `elements` field). Distinct from `MOTION_REFERENCE_ENDPOINTS`,
 * which switch to a different endpoint.
 */
const MOTION_INLINE_REFERENCE_MODELS = {
  kling_v3_pro: true,
} as const satisfies Partial<Record<ImageToVideoModel, true>>;

/**
 * Get the reference-to-video endpoint config for a motion model, if it has one.
 * @returns The endpoint config, or null if the model has no reference endpoint
 */
export function getMotionReferenceEndpoint(
  model: ImageToVideoModel
): MotionReferenceEndpointConfig | null {
  return MOTION_REFERENCE_ENDPOINTS[model] ?? null;
}

export function attachesInlineReferences(model: ImageToVideoModel): boolean {
  return model in MOTION_INLINE_REFERENCE_MODELS;
}

/**
 * Check if a model supports reference images via an edit endpoint
 * @param model - The text-to-image model key
 * @returns true if the model has an edit endpoint for reference images
 */
export function supportsReferenceImages(model: TextToImageModel): boolean {
  return model in EDIT_ENDPOINTS;
}
