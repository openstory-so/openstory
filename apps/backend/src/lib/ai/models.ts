/**
 * AI Model definitions and constants
 * Centralized model IDs for Fal.ai, LetzAI, and OpenRouter
 */

// Fal.ai Image Models
export const FAL_IMAGE_MODELS = {
  // Flux models (high quality)
  flux_pro: "fal-ai/flux-pro",
  flux_dev: "fal-ai/flux/dev",
  flux_schnell: "fal-ai/flux/schnell",
  flux_krea_lora: "fal-ai/flux-lora",

  // Imagen models (Google)
  imagen4: "fal-ai/imagen4",

  // SDXL models
  sdxl: "fal-ai/fast-sdxl",
  sdxl_lightning: "fal-ai/fast-lightning-sdxl",
} as const;

export type FalImageModel =
  (typeof FAL_IMAGE_MODELS)[keyof typeof FAL_IMAGE_MODELS];

// Fal.ai Video Models
export const FAL_VIDEO_MODELS = {
  // Google Veo
  veo3: "fal-ai/veo3",

  // Kling Video
  kling_video: "fal-ai/kling-video/v1/standard/image-to-video",
  kling_pro: "fal-ai/kling-video/v1/pro/image-to-video",

  // Minimax Hailuo
  minimax_hailuo: "fal-ai/minimax/hailuo-video",

  // Wan (with VFX LoRA support)
  wan_pro: "fal-ai/wan-pro",

  // Stable Video Diffusion
  svd: "fal-ai/stable-video",
  svd_lcm: "fal-ai/fast-svd-lcm",
} as const;

export type FalVideoModel =
  (typeof FAL_VIDEO_MODELS)[keyof typeof FAL_VIDEO_MODELS];

// LetzAI Modes
export const LETZAI_MODES = {
  default: 0,
  anime: 1,
  realistic: 2,
  creative: 3,
} as const;

export type LetzAIMode = keyof typeof LETZAI_MODES;

// OpenRouter Models
export const OPENROUTER_MODELS = {
  // Anthropic Claude
  claude_opus: "anthropic/claude-3-opus",
  claude_sonnet: "anthropic/claude-3-sonnet",
  claude_haiku: "anthropic/claude-3-haiku",

  // OpenAI GPT
  gpt4_turbo: "openai/gpt-4-turbo",
  gpt4o: "openai/gpt-4o",
  gpt4o_mini: "openai/gpt-4o-mini",

  // Meta Llama
  llama3_70b: "meta-llama/llama-3-70b-instruct",
  llama3_8b: "meta-llama/llama-3-8b-instruct",
} as const;

export type OpenRouterModel =
  (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];

// Model pricing (in credits per request)
export const MODEL_PRICING = {
  // Fal.ai Image Models (credits)
  [FAL_IMAGE_MODELS.flux_pro]: 0.055,
  [FAL_IMAGE_MODELS.flux_dev]: 0.025,
  [FAL_IMAGE_MODELS.flux_schnell]: 0.003,
  [FAL_IMAGE_MODELS.flux_krea_lora]: 0.03,
  [FAL_IMAGE_MODELS.imagen4]: 0.04,
  [FAL_IMAGE_MODELS.sdxl]: 0.003,
  [FAL_IMAGE_MODELS.sdxl_lightning]: 0.002,

  // Fal.ai Video Models (credits)
  [FAL_VIDEO_MODELS.veo3]: 0.5,
  [FAL_VIDEO_MODELS.kling_video]: 0.3,
  [FAL_VIDEO_MODELS.kling_pro]: 0.6,
  [FAL_VIDEO_MODELS.minimax_hailuo]: 0.4,
  [FAL_VIDEO_MODELS.wan_pro]: 0.35,
  [FAL_VIDEO_MODELS.svd]: 0.15,
  [FAL_VIDEO_MODELS.svd_lcm]: 0.08,

  // OpenRouter Models (USD per 1M tokens)
  [OPENROUTER_MODELS.claude_opus]: 15.0,
  [OPENROUTER_MODELS.claude_sonnet]: 3.0,
  [OPENROUTER_MODELS.claude_haiku]: 0.25,
  [OPENROUTER_MODELS.gpt4_turbo]: 10.0,
  [OPENROUTER_MODELS.gpt4o]: 5.0,
  [OPENROUTER_MODELS.gpt4o_mini]: 0.15,
  [OPENROUTER_MODELS.llama3_70b]: 0.9,
  [OPENROUTER_MODELS.llama3_8b]: 0.2,
} as const;

// Model capabilities
export interface ModelCapabilities {
  maxWidth: number;
  maxHeight: number;
  supportsLoRA: boolean;
  supportsControlNet: boolean;
  supportsInpainting: boolean;
  supportsUpscaling: boolean;
}

export const IMAGE_MODEL_CAPABILITIES: Record<
  FalImageModel,
  ModelCapabilities
> = {
  [FAL_IMAGE_MODELS.flux_pro]: {
    maxWidth: 2048,
    maxHeight: 2048,
    supportsLoRA: true,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.flux_dev]: {
    maxWidth: 2048,
    maxHeight: 2048,
    supportsLoRA: true,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.flux_schnell]: {
    maxWidth: 1024,
    maxHeight: 1024,
    supportsLoRA: false,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.flux_krea_lora]: {
    maxWidth: 2048,
    maxHeight: 2048,
    supportsLoRA: true,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.imagen4]: {
    maxWidth: 2048,
    maxHeight: 2048,
    supportsLoRA: false,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.sdxl]: {
    maxWidth: 1024,
    maxHeight: 1024,
    supportsLoRA: true,
    supportsControlNet: true,
    supportsInpainting: true,
    supportsUpscaling: false,
  },
  [FAL_IMAGE_MODELS.sdxl_lightning]: {
    maxWidth: 1024,
    maxHeight: 1024,
    supportsLoRA: false,
    supportsControlNet: false,
    supportsInpainting: false,
    supportsUpscaling: false,
  },
};

// Video model capabilities
export interface VideoModelCapabilities {
  maxDuration: number; // seconds
  maxFPS: number;
  supportsLoRA: boolean;
  supportsMotionControl: boolean;
}

export const VIDEO_MODEL_CAPABILITIES: Record<
  FalVideoModel,
  VideoModelCapabilities
> = {
  [FAL_VIDEO_MODELS.veo3]: {
    maxDuration: 10,
    maxFPS: 30,
    supportsLoRA: false,
    supportsMotionControl: true,
  },
  [FAL_VIDEO_MODELS.kling_video]: {
    maxDuration: 5,
    maxFPS: 30,
    supportsLoRA: false,
    supportsMotionControl: true,
  },
  [FAL_VIDEO_MODELS.kling_pro]: {
    maxDuration: 10,
    maxFPS: 30,
    supportsLoRA: false,
    supportsMotionControl: true,
  },
  [FAL_VIDEO_MODELS.minimax_hailuo]: {
    maxDuration: 6,
    maxFPS: 25,
    supportsLoRA: false,
    supportsMotionControl: false,
  },
  [FAL_VIDEO_MODELS.wan_pro]: {
    maxDuration: 5,
    maxFPS: 24,
    supportsLoRA: true,
    supportsMotionControl: true,
  },
  [FAL_VIDEO_MODELS.svd]: {
    maxDuration: 4,
    maxFPS: 7,
    supportsLoRA: false,
    supportsMotionControl: true,
  },
  [FAL_VIDEO_MODELS.svd_lcm]: {
    maxDuration: 2,
    maxFPS: 7,
    supportsLoRA: false,
    supportsMotionControl: true,
  },
};
