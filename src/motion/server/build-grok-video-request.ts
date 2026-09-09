/**
 * Native Grok Imagine 1.5 generateVideo payload. Shared by submitMotionJob
 * and the scene editor's optimised-prompt preview so the JSON on screen is
 * the request xAI actually gets — not the fal i2v bag (which substitutes
 * tokens with descriptions and never sends reference URLs).
 *
 * Client-safe: no env, no adapters.
 */

import { NATIVE_GROK_VIDEO_MODEL } from '@/models/grok-native';
import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/models/models';
import type { AspectRatio } from '@/models/aspect-ratios';
import { pickVideoResolution, type Resolution } from '@/models/resolutions';
import type { GrokVideoProviderOptions } from '@tanstack/ai-grok';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
import {
  buildReferenceVideoPrompt,
  type ReferencePromptBinding,
} from './build-reference-video-prompt';

/**
 * Imagine 1.5 reference-to-video: up to 7 library refs, tagged `<IMAGE_0>`,
 * `<IMAGE_1>`, … in that order (xAI numbers from zero).
 *
 * The rendered still is NOT one of them. xAI documents `image` combined with
 * `reference_images` as the matching first-frame pin, so the still is pinned
 * as the opening frame and the whole 7-slot budget stays available for
 * sheets. It used to be demoted into reference slot 0 — a real quality loss,
 * since a pinned first frame is honoured exactly while a reference is only
 * an influence — on the belief that xAI forbade the combination.
 *
 * `@tanstack/ai-grok` still believes that: `createVideoJob` throws on
 * `startFrame && hasReference`. So the still rides `modelOptions.image`
 * rather than a `start_frame` prompt part — the adapter destructures only
 * `duration` / `reference_images` / `reference_audios` / `mode` out of
 * modelOptions and spreads the rest straight into the request body, which is
 * the same passthrough `reference_audios` itself depends on. Delete the
 * workaround once the upstream guard is lifted; the request shape is
 * identical either way.
 *
 * NO `maxAudio` (#1559), and the reason is a gate rather than a gap. Imagine
 * 1.5 does take audio references — `reference_audios`, up to 3, tagged
 * `<AUDIO_0>`…`<AUDIO_2>` alongside the image tags — but the shape is
 * `{ voice_id: 'eve' }`, a PRESET voice from the same roster as xAI's
 * text-to-speech. That is a voice picker, which #1556 owns, not an uploaded
 * file. Per docs.x.ai: "Preset voices are generally available. Voice
 * references with your own audio files are available to trusted partners, on
 * request." So an uploaded audio element cannot ride this route until we hold
 * that access, and it is described in prose instead. If we ever get it, note
 * the audio arrives in `modelOptions.reference_audios`, NOT as an audio
 * prompt part — the adapter throws on those.
 */
const GROK_VIDEO_REFERENCE_CONFIG = {
  tag: (position: number) => `<IMAGE_${position - 1}>`,
  maxImages: 7,
} satisfies ReferencePromptBinding;

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
  /**
   * Passthrough options for the xAI body. Carries the pinned opening frame
   * (`image`) when the shot has both a still and references — see the note on
   * `GROK_VIDEO_REFERENCE_CONFIG`. Intersected with the adapter's own option
   * type so the submit site needs no cast: `image` is a real field on xAI's
   * `/v1/videos/generations` body that `GrokVideoProviderOptions` does not
   * model yet, and the adapter spreads unmodelled options straight through.
   */
  modelOptions?: GrokVideoProviderOptions & { image: { url: string } };
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
  /** The rendered still, or undefined in reference-only mode. */
  imageUrl?: string;
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

  const startFrameUrl = options.imageUrl;

  if (attached.length === 0) {
    const text =
      options.prompt.length <= maxPromptLength
        ? options.prompt
        : `${options.prompt.slice(0, maxPromptLength - 3)}...`;
    return {
      endpointId: NATIVE_GROK_VIDEO_MODEL,
      input: {
        // Reference-only with nothing matched is text-to-video: no image parts.
        prompt: grokVideoPromptParts(
          text,
          startFrameUrl ? [{ url: startFrameUrl, role: 'start_frame' }] : []
        ),
        duration,
        ...(size && { size }),
      },
    };
  }

  // `null`, not the still: the still is pinned as the opening frame below and
  // never consumes a reference slot, so the first real reference is
  // `<IMAGE_0>` and the binding writes no "use X as the starting frame" line.
  const { prompt, imageUrls } = buildReferenceVideoPrompt(
    GROK_VIDEO_REFERENCE_CONFIG,
    options.prompt,
    null,
    references,
    maxPromptLength
  );
  // Only image references reach `imageUrls` — xAI has no reference clip slot,
  // and its audio slot takes a preset `voice_id` rather than a file (#1559) —
  // so those are inlined as prose by the binding and cannot shift the role
  // alignment here.
  const usable = attached
    .filter((ref) => (ref.kind ?? 'image') === 'image')
    .slice(0, GROK_VIDEO_REFERENCE_CONFIG.maxImages);
  return {
    endpointId: NATIVE_GROK_VIDEO_MODEL,
    input: {
      prompt: grokVideoPromptParts(
        prompt,
        imageUrls.map((url, index) => ({
          url,
          role: grokReferencePartRole(usable[index]?.role),
        }))
      ),
      duration,
      ...(size && { size }),
      ...(startFrameUrl && { modelOptions: { image: { url: startFrameUrl } } }),
    },
  };
}
