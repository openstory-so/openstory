/**
 * Studio clips (#1274). Sequence video keys still pick the family; the
 * `mode` picks the endpoint:
 *
 *   - `text`      — the family's text-to-video sibling (prompt only)
 *   - `reference` — reference-to-video: up to N stills bound in the prompt as
 *                   `@Image1`…`@ImageN`
 *   - `frames`    — image-to-video: a start frame, plus an end frame where the
 *                   endpoint has `end_image_url` (Kling, LTX, Seedance, H3 Max)
 *
 * Client-safe: no env, no adapters.
 */

import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';

const STUDIO_TEXT_TO_VIDEO_ENDPOINTS = {
  grok_imagine_video_1_5: 'xai/grok-imagine-video/v1.5/text-to-video',
  ltx_2_3_pro: 'fal-ai/ltx-2.3/text-to-video',
  veo3_1: 'fal-ai/veo3.1',
  kling_v3_pro: 'fal-ai/kling-video/v3/pro/text-to-video',
  minimax_hailuo_02: 'fal-ai/minimax/hailuo-2.3/pro/text-to-video',
  minimax_h3_max: 'minimax/h3-max/text-to-video',
  seedance_v2: 'bytedance/seedance-2.0/enterprise/v2/text-to-video',
  seedance_v2_5: 'bytedance/seedance-2.5/text-to-video',
} as const satisfies Record<ImageToVideoModel, string>;

const RANGE = (min: number, max: number): readonly number[] =>
  Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** Seconds the T2V sibling accepts. Empty = duration is not a request field. */
const STUDIO_VIDEO_DURATIONS = {
  grok_imagine_video_1_5: RANGE(1, 15),
  ltx_2_3_pro: [6, 8, 10],
  veo3_1: [4, 6, 8],
  kling_v3_pro: RANGE(3, 15),
  minimax_hailuo_02: [],
  minimax_h3_max: RANGE(5, 15),
  seedance_v2: RANGE(4, 15),
  seedance_v2_5: RANGE(4, 30),
} as const satisfies Record<ImageToVideoModel, readonly number[]>;

/** Of our `AspectRatio` set, the ones the T2V sibling accepts. */
const STUDIO_VIDEO_ASPECTS = {
  grok_imagine_video_1_5: ['16:9', '1:1', '9:16'],
  ltx_2_3_pro: ['16:9', '9:16'],
  veo3_1: ['16:9', '9:16'],
  kling_v3_pro: ['16:9', '9:16', '1:1'],
  minimax_hailuo_02: [],
  minimax_h3_max: ['16:9', '1:1', '9:16'],
  seedance_v2: ['16:9', '1:1', '9:16'],
  seedance_v2_5: ['16:9', '1:1', '9:16'],
} as const satisfies Record<ImageToVideoModel, readonly AspectRatio[]>;

const STUDIO_VIDEO_HAS_AUDIO = {
  grok_imagine_video_1_5: false,
  ltx_2_3_pro: true,
  veo3_1: true,
  kling_v3_pro: true,
  minimax_hailuo_02: false,
  minimax_h3_max: false,
  seedance_v2: true,
  seedance_v2_5: true,
} as const satisfies Record<ImageToVideoModel, boolean>;

export const STUDIO_VIDEO_MODES = ['text', 'reference', 'frames'] as const;

export type StudioVideoMode = (typeof STUDIO_VIDEO_MODES)[number];

type StudioReferenceEndpoint = {
  endpointId: string;
  /** Request field the stills go in. */
  imageField: 'image_urls' | 'reference_image_urls';
  /** How the prompt names still N (1-based). */
  imageTag: (n: number) => string;
  maxImages: number;
  /** Bound in the prompt as `@Video1`… (Seedance: MP4/MOV, 2–15s combined, ≤720p). */
  maxVideos: number;
  /** Bound in the prompt as `@Audio1`… (Seedance: MP3/WAV, ≤15s combined). */
  maxAudio: number;
  /** Shown when the reference sibling is a different Kling/Grok tier. */
  note?: string;
};

const atImage = (n: number): string => `@Image${n}`;

/** Reference-to-video siblings. LTX, Hailuo and H3 Max have none. */
const STUDIO_REFERENCE_ENDPOINTS: Partial<
  Record<ImageToVideoModel, StudioReferenceEndpoint>
> = {
  seedance_v2: {
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/reference-to-video',
    imageField: 'image_urls',
    imageTag: atImage,
    maxImages: 9,
    maxVideos: 3,
    maxAudio: 3,
  },
  seedance_v2_5: {
    endpointId: 'bytedance/seedance-2.5/reference-to-video',
    imageField: 'image_urls',
    imageTag: atImage,
    maxImages: 9,
    maxVideos: 3,
    maxAudio: 3,
  },
  grok_imagine_video_1_5: {
    endpointId: 'xai/grok-imagine-video/v1.5/reference-to-video',
    imageField: 'reference_image_urls',
    // xAI numbers references from zero.
    imageTag: (n) => `<IMAGE_${n - 1}>`,
    maxImages: 7,
    maxVideos: 0,
    maxAudio: 0,
  },
  kling_v3_pro: {
    endpointId: 'fal-ai/kling-video/o3/pro/reference-to-video',
    imageField: 'image_urls',
    imageTag: atImage,
    maxImages: 4,
    maxVideos: 0,
    maxAudio: 0,
    note: 'Reference mode runs on Kling O3 Pro, the tier with a reference endpoint.',
  },
  veo3_1: {
    endpointId: 'fal-ai/veo3.1/reference-to-video',
    imageField: 'image_urls',
    // Veo has no token syntax; name the still in prose.
    imageTag: (n) => `reference image ${n}`,
    maxImages: 3,
    maxVideos: 0,
    maxAudio: 0,
  },
};

export function studioReferenceEndpoint(
  model: ImageToVideoModel
): StudioReferenceEndpoint | null {
  return STUDIO_REFERENCE_ENDPOINTS[model] ?? null;
}

/** Image-to-video endpoints whose schema has `end_image_url`. */
const STUDIO_END_FRAME_MODELS = {
  kling_v3_pro: true,
  ltx_2_3_pro: true,
  minimax_h3_max: true,
  seedance_v2: true,
  seedance_v2_5: true,
} as const satisfies Partial<Record<ImageToVideoModel, true>>;

/** 0 when the model has no reference-to-video sibling. */
export function studioReferenceLimit(model: ImageToVideoModel): number {
  return STUDIO_REFERENCE_ENDPOINTS[model]?.maxImages ?? 0;
}

/** 0 when the reference endpoint takes no video clips. */
export function studioVideoRefLimit(model: ImageToVideoModel): number {
  return STUDIO_REFERENCE_ENDPOINTS[model]?.maxVideos ?? 0;
}

/** 0 when the reference endpoint takes no audio. */
export function studioAudioLimit(model: ImageToVideoModel): number {
  return STUDIO_REFERENCE_ENDPOINTS[model]?.maxAudio ?? 0;
}

export function studioSupportsEndFrame(model: ImageToVideoModel): boolean {
  return model in STUDIO_END_FRAME_MODELS;
}

export function studioSupportsMode(
  model: ImageToVideoModel,
  mode: StudioVideoMode
): boolean {
  return mode !== 'reference' || studioReferenceLimit(model) > 0;
}

/** Prompt-token prefix, not a media kind (that is `StudioReferenceKind`). */
export type StudioReferenceToken = 'Image' | 'Video' | 'Audio';

/**
 * Bare `ImageN` / `VideoN` / `AudioN` tokens (what the pill stores) → the
 * provider's syntax: `@ImageN` by default, or the model's own still tag.
 */
export function tagStudioReferences(
  prompt: string,
  model?: ImageToVideoModel
): string {
  const imageTag = model
    ? (STUDIO_REFERENCE_ENDPOINTS[model]?.imageTag ?? atImage)
    : atImage;
  return prompt.replace(
    /(^|[^A-Za-z0-9_@-])(Image|Video|Audio)(\d+)(?=[^A-Za-z0-9_-]|$)/g,
    (_match, prefix: string, kind: string, digits: string) =>
      kind === 'Image'
        ? `${prefix}${imageTag(Number(digits))}`
        : `${prefix}@${kind}${digits}`
  );
}

/**
 * Drop the `Image{removed+1}` token and shift the ones after it down by one,
 * so the prompt keeps pointing at the same stills after a tile is removed.
 */
export function renumberStudioReferences(
  prompt: string,
  removedIndex: number,
  kind: StudioReferenceToken = 'Image'
): string {
  return prompt.replace(
    new RegExp(`(^|[^A-Za-z0-9_-])@?${kind}(\\d+)(?=[^A-Za-z0-9_-]|$)`, 'g'),
    (match: string, prefix: string, digits: string) => {
      const n = Number(digits);
      if (n === removedIndex + 1) return prefix;
      if (n > removedIndex + 1) return `${prefix}${kind}${n - 1}`;
      return match;
    }
  );
}

const STUDIO_VIDEO_RESOLUTION: Partial<Record<ImageToVideoModel, string>> = {
  grok_imagine_video_1_5: '720p',
  veo3_1: '1080p',
  seedance_v2: '720p',
  seedance_v2_5: '720p',
};

export function studioVideoEndpointId(
  model: ImageToVideoModel,
  mode: StudioVideoMode = 'text'
): string {
  switch (mode) {
    case 'text':
      return STUDIO_TEXT_TO_VIDEO_ENDPOINTS[model];
    case 'reference': {
      const reference = STUDIO_REFERENCE_ENDPOINTS[model];
      if (!reference) {
        throw new Error(`${model} has no reference-to-video endpoint`);
      }
      return reference.endpointId;
    }
    case 'frames':
      return IMAGE_TO_VIDEO_MODELS[model].id;
  }
}

/** Every fal endpoint a studio clip can hit, for the pricing refresh. */
export function studioVideoEndpointIds(): string[] {
  return [
    ...Object.values(STUDIO_TEXT_TO_VIDEO_ENDPOINTS),
    ...Object.values(STUDIO_REFERENCE_ENDPOINTS).map((e) => e.endpointId),
  ];
}

export function studioVideoSupportsAudio(model: ImageToVideoModel): boolean {
  return STUDIO_VIDEO_HAS_AUDIO[model];
}

/** Every second count the model accepts, ascending. Empty = not a request field. */
export function studioVideoDurations(
  model: ImageToVideoModel
): readonly number[] {
  return STUDIO_VIDEO_DURATIONS[model];
}

export function snapStudioVideoDuration(
  requested: number | undefined,
  model: ImageToVideoModel
): number {
  const valid = STUDIO_VIDEO_DURATIONS[model];
  if (valid.length === 0) return requested ?? 5;
  const target = requested ?? valid[0] ?? 5;
  return valid.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best
  );
}

function encodeDuration(
  seconds: number,
  model: ImageToVideoModel
): string | number {
  switch (model) {
    case 'kling_v3_pro':
    case 'seedance_v2':
    case 'seedance_v2_5':
      return String(seconds);
    case 'veo3_1':
      return `${seconds}s`;
    default:
      return seconds;
  }
}

function truncatePrompt(prompt: string, model: ImageToVideoModel): string {
  const max = IMAGE_TO_VIDEO_MODELS[model].maxPromptLength;
  if (prompt.length <= max) return prompt;
  return `${prompt.slice(0, max - 3)}...`;
}

type StudioVideoInput = {
  prompt: string;
  model: ImageToVideoModel;
  duration?: number;
  aspectRatio?: AspectRatio;
  generateAudio?: boolean;
};

export type StudioVideoRequest = {
  prompt: string;
  duration: number;
  modelOptions: Record<string, unknown>;
};

/**
 * Fal T2V body for a sequence video key (reference mode adds its media
 * fields on top). Native Grok ignores `modelOptions` and uses `prompt` +
 * `duration` + size.
 */
export function buildStudioVideoInput(
  options: StudioVideoInput
): StudioVideoRequest {
  const { model } = options;
  const prompt = truncatePrompt(options.prompt, model);
  const duration = snapStudioVideoDuration(options.duration, model);
  const modelOptions: Record<string, unknown> = {};

  if (STUDIO_VIDEO_DURATIONS[model].length > 0) {
    modelOptions.duration = encodeDuration(duration, model);
  }

  const allowedAspects: readonly AspectRatio[] = STUDIO_VIDEO_ASPECTS[model];
  if (options.aspectRatio && allowedAspects.includes(options.aspectRatio)) {
    modelOptions.aspect_ratio = options.aspectRatio;
  }

  if (STUDIO_VIDEO_HAS_AUDIO[model] && options.generateAudio !== undefined) {
    modelOptions.generate_audio = options.generateAudio;
  }

  const resolution = STUDIO_VIDEO_RESOLUTION[model];
  if (resolution) modelOptions.resolution = resolution;

  return { prompt, duration, modelOptions };
}
