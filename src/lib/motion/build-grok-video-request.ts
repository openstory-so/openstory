/**
 * Native Grok Imagine 1.5 generateVideo payload. Shared by submitMotionJob
 * and the scene editor's optimised-prompt preview so the JSON on screen is
 * the request xAI actually gets — not the fal i2v bag (which substitutes
 * tokens with descriptions and never sends reference URLs).
 *
 * Client-safe: no env, no adapters.
 */

import { NATIVE_GROK_VIDEO_MODEL } from '@/lib/ai/grok-native';
import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  type MotionReferenceEndpointConfig,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  pickVideoResolution,
  type Resolution,
} from '@/lib/constants/resolutions';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';

/**
 * Imagine 1.5 reference-to-video: still first, then up to 6 library refs
 * (API max 7). Prompt tokens are `<IMAGE_0>`, `<IMAGE_1>`, … in that order
 * — TanStack's grok adapter documents 0-based tags, and xAI forbids mixing
 * a start-frame `image` with `reference_images`.
 */
const GROK_VIDEO_REFERENCE_CONFIG = {
  endpointId: NATIVE_GROK_VIDEO_MODEL,
  tag: (position: number) => `<IMAGE_${position - 1}>`,
  maxImages: 7,
} satisfies MotionReferenceEndpointConfig;

type GrokVideoPromptPart =
  | { type: 'text'; content: string }
  | {
      type: 'image';
      source: { type: 'url'; value: string };
      metadata: { role: 'start_frame' | 'reference' | 'character' };
    };

type GrokVideoRequestInput = {
  prompt: GrokVideoPromptPart[];
  duration: number;
  size?: `${AspectRatio}_${'480p' | '720p' | '1080p'}` | AspectRatio;
};

function grokReferencePartRole(
  role: ReferenceImageDescription['role']
): 'reference' | 'character' {
  return role === 'character' ? 'character' : 'reference';
}

function grokVideoPromptParts(
  text: string,
  images: Array<{
    url: string;
    role: 'start_frame' | 'reference' | 'character';
  }>
): GrokVideoPromptPart[] {
  return [
    { type: 'text', content: text },
    ...images.map((image) => ({
      type: 'image' as const,
      source: { type: 'url' as const, value: image.url },
      metadata: { role: image.role },
    })),
  ];
}

/**
 * The only tokens xAI's `size` template admits. Exported so the studio via
 * narrows against the same list rather than keeping its own copy.
 * Imagine 1.5 image-to-video; reference-to-video is capped at 720p.
 */
export const GROK_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

function grokVideoSize(
  aspectRatio: AspectRatio | undefined,
  resolution: Resolution | undefined,
  hasReferences: boolean
): GrokVideoRequestInput['size'] {
  if (!aspectRatio) return undefined;
  // Reference-to-video is 720p only, whatever tier was asked for (#1449).
  const picked =
    hasReferences || !resolution
      ? '720p'
      : pickVideoResolution(GROK_VIDEO_RESOLUTIONS, resolution);
  // Narrowed by lookup rather than asserted: `pickVideoResolution` returns the
  // string it was given, so only a round-trip through the list proves to the
  // compiler that it is one of the three the template admits.
  const tier = GROK_VIDEO_RESOLUTIONS.find((r) => r === picked) ?? '720p';
  return `${aspectRatio}_${tier}`;
}

export function buildGrokVideoRequest(options: {
  prompt: string;
  imageUrl: string;
  duration?: number;
  aspectRatio?: AspectRatio;
  referenceImages?: ReferenceImageDescription[];
  resolution?: Resolution;
  model?: ImageToVideoModel;
}): {
  endpointId: string;
  input: GrokVideoRequestInput;
} {
  const modelKey = options.model ?? 'grok_imagine_video_1_5';
  const maxPromptLength = IMAGE_TO_VIDEO_MODELS[modelKey].maxPromptLength;
  const references = options.referenceImages ?? [];
  const attached = references.filter((ref) => ref.referenceImageUrl);
  const duration = options.duration ?? 5;
  const size = grokVideoSize(
    options.aspectRatio,
    options.resolution,
    attached.length > 0
  );

  if (attached.length === 0) {
    const text =
      options.prompt.length <= maxPromptLength
        ? options.prompt
        : `${options.prompt.slice(0, maxPromptLength - 3)}...`;
    return {
      endpointId: NATIVE_GROK_VIDEO_MODEL,
      input: {
        prompt: grokVideoPromptParts(text, [
          { url: options.imageUrl, role: 'start_frame' },
        ]),
        duration,
        ...(size && { size }),
      },
    };
  }

  const { prompt, imageUrls } = buildReferenceVideoPrompt(
    GROK_VIDEO_REFERENCE_CONFIG,
    options.prompt,
    options.imageUrl,
    references,
    maxPromptLength
  );
  const usable = attached.slice(0, GROK_VIDEO_REFERENCE_CONFIG.maxImages - 1);
  return {
    endpointId: NATIVE_GROK_VIDEO_MODEL,
    input: {
      prompt: grokVideoPromptParts(
        prompt,
        imageUrls.map((url, index) => ({
          url,
          role:
            index === 0
              ? 'reference'
              : grokReferencePartRole(usable[index - 1]?.role),
        }))
      ),
      duration,
      ...(size && { size }),
    },
  };
}
