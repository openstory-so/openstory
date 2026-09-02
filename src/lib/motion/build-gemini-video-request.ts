/**
 * Native Gemini Omni Flash generateVideo payload (Interactions API). Shared
 * by submitMotionJob and the scene editor's optimised-prompt preview so the
 * JSON on screen is the request Google actually gets — not the fal i2v bag
 * (which substitutes tokens with descriptions and never sends reference
 * URLs).
 *
 * Client-safe: no env, no adapters.
 */

import { NATIVE_GEMINI_VIDEO_MODEL } from '@/lib/ai/gemini-native';
import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  type MotionReferenceEndpointConfig,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';
import { snapDuration } from './snap-duration';

/**
 * Omni Flash reference-to-video: still first, then up to 6 library refs
 * (the API caps a request at 7 reference images). Prompt tokens are
 * `<IMAGE_REF_0>`, `<IMAGE_REF_1>`, … in that order — Google numbers
 * references from zero, and the Interactions API has no start-frame field,
 * so the still rides as the first reference bound by the prompt's opening
 * line.
 */
const GEMINI_VIDEO_REFERENCE_CONFIG = {
  endpointId: NATIVE_GEMINI_VIDEO_MODEL,
  tag: (position: number) => `<IMAGE_REF_${position - 1}>`,
  maxImages: 7,
} satisfies MotionReferenceEndpointConfig;

type GeminiVideoPromptPart =
  | { type: 'text'; content: string }
  | {
      type: 'image';
      source:
        | { type: 'url'; value: string }
        | { type: 'data'; value: string; mimeType: string };
    };

/** Omni Flash outputs only these two shapes. Resolution stays 720p unless
 *  we pass a top-level `size` suffix (`16:9_1080p`); we don't, because that
 *  makes the adapter rebuild `response_format` without `delivery: "uri"`. */
export type GeminiVideoSize = '16:9' | '9:16';

export type GeminiVideoTask =
  | 'image_to_video'
  | 'reference_to_video'
  | 'text_to_video';

/**
 * Ask the Interactions API to park the MP4 on the Files API. Inline
 * base64 (`data:`) is the default and a 720p clip misses Cloudflare
 * Workflows' 1 MiB `step.do` cap.
 *
 * The TanStack Gemini adapter overwrites `response_format` whenever
 * `generateVideo` is passed top-level `duration` / `size`, so native
 * submit must send duration and aspect HERE and omit those top-level
 * fields.
 */
const GEMINI_VIDEO_URI_DELIVERY = 'uri' as const;

function geminiVideoResponseFormat(
  durationSeconds: number,
  size?: GeminiVideoSize
): {
  type: 'video';
  delivery: typeof GEMINI_VIDEO_URI_DELIVERY;
  duration: string;
  aspect_ratio?: GeminiVideoSize;
} {
  return {
    type: 'video',
    delivery: GEMINI_VIDEO_URI_DELIVERY,
    duration: `${durationSeconds}s`,
    ...(size && { aspect_ratio: size }),
  };
}

type GeminiVideoModelOptions = {
  generation_config: {
    video_config: { task: GeminiVideoTask };
  };
  /**
   * `delivery: "uri"` is load-bearing: the TanStack adapter overwrites
   * `response_format` whenever generateVideo is passed top-level `duration`
   * / `size`, so callers must send duration/aspect HERE and omit those
   * top-level fields. Inline (`data:`) delivery blows the Workflows 1 MiB
   * step-result cap.
   */
  response_format: ReturnType<typeof geminiVideoResponseFormat>;
};

type GeminiVideoRequestInput = {
  prompt: GeminiVideoPromptPart[];
  duration: number;
  size?: GeminiVideoSize;
  modelOptions: GeminiVideoModelOptions;
};

export function geminiNativeModelOptions(
  task: GeminiVideoTask,
  durationSeconds: number,
  size?: GeminiVideoSize
): GeminiVideoModelOptions {
  return {
    generation_config: { video_config: { task } },
    response_format: geminiVideoResponseFormat(durationSeconds, size),
  };
}

/**
 * An image URL (or data URI) as a prompt image part. Interactions content
 * takes inline base64 or a URI — a `data:` URI must be decomposed into the
 * inline form, since Google won't fetch it as a URL. Exported for the studio
 * submit path, which assembles its own part list.
 */
export function geminiImagePart(url: string): GeminiVideoPromptPart {
  const dataUri = /^data:([^;,]+);base64,(.*)$/.exec(url);
  if (dataUri?.[1] && dataUri[2] !== undefined) {
    return {
      type: 'image',
      source: { type: 'data', value: dataUri[2], mimeType: dataUri[1] },
    };
  }
  return { type: 'image', source: { type: 'url', value: url } };
}

function geminiVideoPromptParts(
  text: string,
  imageUrls: string[]
): GeminiVideoPromptPart[] {
  // Images lead: the adapter groups interaction content as images, then the
  // text prompt, and keeping the array in that order makes the on-screen
  // JSON match the wire.
  return [...imageUrls.map(geminiImagePart), { type: 'text', content: text }];
}

export function geminiVideoSize(
  aspectRatio: AspectRatio | undefined
): GeminiVideoSize | undefined {
  if (aspectRatio === undefined) return undefined;
  if (aspectRatio === '16:9' || aspectRatio === '9:16') return aspectRatio;
  throw new Error(
    `Gemini Omni Flash only outputs 16:9 or 9:16 (got ${aspectRatio})`
  );
}

export function buildGeminiVideoRequest(options: {
  prompt: string;
  imageUrl: string;
  duration?: number;
  aspectRatio?: AspectRatio;
  referenceImages?: ReferenceImageDescription[];
  model?: ImageToVideoModel;
}): {
  endpointId: string;
  input: GeminiVideoRequestInput;
} {
  const modelKey = options.model ?? 'gemini_omni_flash';
  const maxPromptLength = IMAGE_TO_VIDEO_MODELS[modelKey].maxPromptLength;
  const attached = (options.referenceImages ?? []).filter(
    (ref) => ref.referenceImageUrl
  );
  const duration = snapDuration(options.duration, modelKey);
  const size = geminiVideoSize(options.aspectRatio);

  if (attached.length === 0) {
    const text =
      options.prompt.length <= maxPromptLength
        ? options.prompt
        : `${options.prompt.slice(0, maxPromptLength - 3)}...`;
    return {
      endpointId: NATIVE_GEMINI_VIDEO_MODEL,
      input: {
        prompt: geminiVideoPromptParts(text, [options.imageUrl]),
        duration,
        ...(size && { size }),
        modelOptions: geminiNativeModelOptions(
          'image_to_video',
          duration,
          size
        ),
      },
    };
  }

  const { prompt, imageUrls } = buildReferenceVideoPrompt(
    GEMINI_VIDEO_REFERENCE_CONFIG,
    options.prompt,
    options.imageUrl,
    options.referenceImages ?? [],
    maxPromptLength
  );
  return {
    endpointId: NATIVE_GEMINI_VIDEO_MODEL,
    input: {
      prompt: geminiVideoPromptParts(prompt, imageUrls),
      duration,
      ...(size && { size }),
      modelOptions: geminiNativeModelOptions(
        'reference_to_video',
        duration,
        size
      ),
    },
  };
}
