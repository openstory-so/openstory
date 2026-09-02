/**
 * Pure assembly of the exact BytePlus Ark request for a motion generation
 * (#1157) — the Ark analogue of `build-model-input.ts`.
 *
 * Ark is not fal-shaped, so none of the fal codegen (`bun motion:codegen`,
 * `MOTION_TRANSFORMS`) applies: there is no endpoint id, `size` is a
 * `ratio_resolution` template rather than an `aspect_ratio` field (and
 * first-frame / first-last-frame jobs may only send `adaptive`), and images
 * ride as roled prompt parts instead of `image_url` / `image_urls[]`.
 *
 * The one constraint that shapes this file: **Ark rejects frame roles and
 * reference roles in the same request.** So a shot with cast/element
 * references cannot also pin its rendered still as `first_frame` — the still
 * becomes the first `reference` image and the prompt declares it as the
 * opening frame, which is exactly what fal's `reference-to-video` endpoint
 * does for the same underlying model. That keeps one prompt-binding
 * implementation (`buildReferenceVideoPrompt`) across both routes. Seedance
 * 2.5 tags are `@Image1`/`@Image2` on fal and Ark. Ark does not want a
 * trailing "Reference images:" legend.
 *
 * Client-safe: no env, no adapters.
 */

import {
  getMotionReferenceEndpoint,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/lib/prompts/reference-legend';
import {
  pickVideoResolution,
  type Resolution,
} from '@/lib/constants/resolutions';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';

/**
 * Resolution tokens Ark serves for Seedance. Matches the fal route's enum, so
 * switching route doesn't silently change what a shot costs or how it looks.
 * A missing tier falls back to 720p — the old fixed value (#1449).
 */
const BYTEPLUS_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;

/** One entry of the Ark prompt-parts array. */
type BytePlusPromptPart =
  | { type: 'text'; content: string }
  | {
      type: 'image';
      source: { type: 'url'; value: string };
      metadata?: { role: 'start_frame' | 'reference' };
    };

export type BytePlusVideoRequest = {
  /** BytePlus Ark model id (not a fal endpoint). */
  modelId: string;
  prompt: BytePlusPromptPart[];
  /** `ratio_resolution` template. Frame jobs are `adaptive_720p`. */
  size: string;
  /** Whole seconds; the adapter snaps it into the model's range. */
  duration?: number;
  modelOptions: Record<string, unknown>;
};

export type BytePlusVideoRequestOptions = {
  imageUrl: string;
  prompt: string;
  aspectRatio?: AspectRatio;
  duration?: number;
  resolution?: Resolution;
  generateAudio?: boolean;
  referenceImages?: ReferenceImageDescription[];
};

function truncate(prompt: string, maxLength: number): string {
  return prompt.length <= maxLength
    ? prompt
    : `${prompt.slice(0, maxLength - 3)}...`;
}

/**
 * Build the Ark request for a motion run.
 *
 * @throws Error when the model has no BytePlus via — callers claim the via
 * first (`isNativeBytePlusVideoModel` + `claimBytePlusVia`), so reaching
 * here without one is a bug rather than a silent fallback.
 */
export function buildBytePlusVideoRequest(
  options: BytePlusVideoRequestOptions,
  modelKey: ImageToVideoModel
): BytePlusVideoRequest {
  const config = IMAGE_TO_VIDEO_MODELS[modelKey];
  const modelId = 'byteplusId' in config ? config.byteplusId : undefined;
  if (!modelId) {
    throw new Error(`No BytePlus model id for motion model "${modelKey}"`);
  }

  const references = (options.referenceImages ?? []).filter(
    (ref) => ref.referenceImageUrl
  );
  // Seedance 2.5 first-frame / first-last-frame rejects a concrete ratio
  // (`9:16`, `16:9`, …). Output follows the first-frame still; `adaptive`
  // is the only accepted value. Sequence motion always sends a still.
  const size = `adaptive_${
    (options.resolution &&
      pickVideoResolution(BYTEPLUS_RESOLUTIONS, options.resolution)) ??
    '720p'
  }`;

  const modelOptions: Record<string, unknown> = {
    // Ark defaults `watermark` to false for video, but state it: the flag is
    // per-request and a provider-side default change would burn a mark into
    // every clip we have already sold.
    watermark: false,
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
  };

  if (references.length === 0) {
    return {
      modelId,
      prompt: [
        {
          type: 'text',
          content: truncate(options.prompt, config.maxPromptLength),
        },
        {
          type: 'image',
          source: { type: 'url', value: options.imageUrl },
          metadata: { role: 'start_frame' },
        },
      ],
      size,
      duration: options.duration,
      modelOptions,
    };
  }

  // Reference mode. The still cannot be a frame role here (see file header),
  // so it leads the reference list and the prompt names it as the opening
  // frame — the binding `buildReferenceVideoPrompt` already writes for fal.
  const referenceConfig = getMotionReferenceEndpoint(modelKey);
  const { prompt, imageUrls } = referenceConfig
    ? buildReferenceVideoPrompt(
        referenceConfig,
        options.prompt,
        options.imageUrl,
        references,
        config.maxPromptLength,
        { skipLegend: true }
      )
    : // A model with a BytePlus route but no reference-tag convention can't
      // bind images to prompt positions; inline the descriptions instead so
      // the prompt stays self-contained and send the still alone.
      {
        prompt: truncate(
          substituteReferenceTags(
            options.prompt,
            references.map((ref) => ({
              token: ref.token,
              render: inlineReferenceDescription(ref),
            }))
          ).prompt,
          config.maxPromptLength
        ),
        imageUrls: [options.imageUrl],
      };

  return {
    modelId,
    prompt: [
      { type: 'text', content: prompt },
      ...imageUrls.map((url): BytePlusPromptPart => ({
        type: 'image',
        source: { type: 'url', value: url },
        metadata: { role: 'reference' },
      })),
    ],
    size,
    duration: options.duration,
    modelOptions,
  };
}
