/**
 * Schema-Driven Model Input Builder
 *
 * Builds the fal.ai request body for a video model using generated
 * Zod transforms. Each transform accepts our internal camelCase format
 * (numeric duration, imageUrl) and produces the API's snake_case format
 * with correctly-typed duration values.
 */

import {
  getMotionReferenceEndpoint,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/models/models';
import type { z } from 'zod';
import {
  bindableReferences,
  buildReferenceVideoPrompt,
} from './build-reference-video-prompt';
import {
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/stills/reference-legend';
import { pickVideoResolution } from '@/models/resolutions';
import {
  MOTION_JSON_SCHEMAS,
  MOTION_TRANSFORMS,
  type MotionEndpointId,
} from './endpoint-map';
import { hasStartFrameField } from './motion-transform';
import { resolveMotionEndpoint } from '@/motion/resolve-motion-endpoint';
import type { GenerateMotionOptions } from './motion-generation';

/** Intentional deviations from API defaults */
const QUALITY_OVERRIDES: Partial<
  Record<ImageToVideoModel, Record<string, unknown>>
> = {
  // Required on i2v and r2v; schema default is the same value.
  minimax_h3_max: { prompt_expansion_mode: 'balanced' },
};

/**
 * The `resolution` tokens an endpoint advertises, read off the generated fal
 * schema. Empty for an endpoint with no such field (Kling v3),
 * whose output size is fixed.
 */
export function motionResolutionTokens(endpointId: MotionEndpointId): string[] {
  const schema: { properties?: Record<string, unknown> } =
    MOTION_JSON_SCHEMAS[endpointId];
  const field: unknown = schema.properties?.resolution;
  if (!field || typeof field !== 'object' || !('enum' in field)) return [];
  const values: unknown = field.enum;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * The requested resolution tier (#1449) in the endpoint's own vocabulary —
 * `'768P'` on H3 Max, `'4k'` on Seedance 2.0. Read off the
 * generated fal schema, so a new motion model needs no entry anywhere: it
 * inherits whatever its `resolution` enum advertises, and an endpoint with no
 * such field (Kling v3) keeps its fixed output.
 *
 * Empty when no tier was asked for, which leaves the schema default in place.
 */
function resolutionOverride(
  endpointId: MotionEndpointId,
  resolution: GenerateMotionOptions['resolution']
): { resolution?: string } {
  if (!resolution) return {};
  const options = motionResolutionTokens(endpointId);
  if (options.length === 0) return {};
  const picked = pickVideoResolution(options, resolution);
  return picked ? { resolution: picked } : {};
}

/**
 * Second lever against model-generated music (#1165) for the two endpoints
 * that expose `negative_prompt`; the in-prompt direction from
 * `assembleMotionPrompt` covers every audio-capable model, and is Seedance
 * 2.5's only lever since its schema has no negative prompt.
 *
 * Kling's `negative_prompt` defaults to 'blur, distort, and low quality' when
 * absent — supplying our own replaces it, so those terms are carried over.
 */
const NO_MUSIC_NEGATIVE_PROMPTS: Partial<Record<ImageToVideoModel, string>> = {
  kling_v3_pro:
    'blur, distort, and low quality, background music, musical score, soundtrack',
};

type ModelOutputMap = {
  [K in ImageToVideoModel]: z.output<
    (typeof MOTION_TRANSFORMS)[(typeof IMAGE_TO_VIDEO_MODELS)[K]['id']]
  >;
};

export function buildModelInput<T extends ImageToVideoModel>(
  options: GenerateMotionOptions,
  modelConfig: (typeof IMAGE_TO_VIDEO_MODELS)[T],
  modelKey: T
): ModelOutputMap[T] {
  const endpointId: (typeof IMAGE_TO_VIDEO_MODELS)[T]['id'] = modelConfig.id;
  const transform = MOTION_TRANSFORMS[endpointId];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- defensive guard for exhaustiveness
  if (!transform) {
    throw new Error(
      `No motion transform registered for endpoint: ${endpointId}`
    );
  }
  // This builder is the image-to-video path: a start frame is required, and
  // reference images are not attached here. Models with a dedicated
  // reference-to-video sibling (Seedance, H3 Max, Kling O3, Omni Flash) are
  // routed there by `buildMotionRequest` before this runs. Tokens in the
  // prompt are substituted with bible descriptions so a line written as
  // "SCARLETT lifts the CORAL_LIPSTICK" stays self-contained.
  const references = options.referenceImages ?? [];
  const prompt =
    references.length > 0
      ? substituteReferenceTags(
          options.prompt,
          references.map((ref) => ({
            token: ref.token,
            render: inlineReferenceDescription(ref),
          }))
        ).prompt
      : options.prompt;

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion safe to cast here because we know the transform is valid
  const result = transform.parse({
    prompt,
    duration: options.duration,
    // Every endpoint reaching this builder requires a start frame;
    // `buildMotionRequest` asserts one is present before calling in.
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio,
    ...QUALITY_OVERRIDES[modelKey],
    ...resolutionOverride(endpointId, options.resolution),
    ...(NO_MUSIC_NEGATIVE_PROMPTS[modelKey] && {
      negative_prompt: NO_MUSIC_NEGATIVE_PROMPTS[modelKey],
    }),
    // Resolved from the catalog, never inherited from the schema default: a
    // model's routes can disagree (Kling v3 image-to-video defaults true, its
    // O3 reference/text siblings default false), which would let the route a
    // shot happens to take decide whether the clip has sound (#1498). Models
    // with no `generate_audio` field strip it during apiSchema.parse.
    generate_audio: options.generateAudio ?? videoModelSupportsAudio(modelKey),
    ...(options.multiPrompt &&
      options.multiPrompt.length > 0 && {
        multi_prompt: options.multiPrompt,
        shot_type: 'customize',
      }),
  }) as ModelOutputMap[T];

  return applyKlingMultiPrompt(result, options.multiPrompt);
}

/**
 * Kling rejects `prompt` and `multi_prompt` together. The transform always
 * requires a prompt string, so a packed job still parses one and then this
 * drops it.
 */
function applyKlingMultiPrompt<T extends { prompt?: unknown }>(
  input: T,
  multiPrompt: GenerateMotionOptions['multiPrompt']
): T {
  if (!multiPrompt?.length) return input;
  const { prompt: _prompt, ...rest } = input;
  // Kling forbids prompt + multi_prompt together; the transform still
  // requires a prompt string, so strip it after parse.
  const packed = {
    ...rest,
    multi_prompt: multiPrompt,
    shot_type: 'customize' as const,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- packed Kling body is T minus prompt
  return packed as unknown as T;
}

/** Output of any registered fal transform: the reference-to-video and
 *  text-to-video rows `MOTION_REFERENCE_ENDPOINTS` names are typed
 *  `MotionEndpointId`, so this can never drift from the map. */
type RegisteredMotionOutput = z.output<
  (typeof MOTION_TRANSFORMS)[MotionEndpointId]
>;

/**
 * Resolve the endpoint and build the exact fal request body for a motion run
 * (#873). Shared by `submitMotionJob` and the scene editor's optimised-prompt
 * preview, so what the user sees is what fal receives — the only difference at
 * submit time is that locally-served `/r2/` URLs are swapped for externally
 * fetchable ones first.
 *
 * When `resolveMotionEndpoint` routes to a dedicated reference-to-video
 * endpoint (Seedance / H3 Max / Kling O3 / Omni Flash with cast/element
 * refs), how the still rides depends on whether the endpoint has a real
 * start-frame field. Seedance, H3 Max and Omni Flash have none, so the still
 * goes first in the image-list field with the sheets after it and the prompt
 * declares it as the opening frame. Kling O3 has `start_image_url`, so the
 * still is pinned there instead (#1498): the frame is guaranteed rather than
 * requested in prose, the whole image list stays available for sheets, and
 * `usesStartFrame: true` keeps meaning what it says.
 *
 * In reference-only mode (`options.referenceOnly`) there is no still at all:
 * the sheets fill the image list from slot 1 and the prompt carries the
 * composition. A reference-only shot that matched no sheets is prompt-only
 * and goes to the model's text-to-video sibling (#1521) — the reference
 * endpoints reject an empty list.
 */
/**
 * Does this reference-to-video submission pin the still in its own
 * start-frame field rather than spending the first image slot on it?
 *
 * Only true where the endpoint actually has such a field (Kling O3) and the
 * shot actually rendered a still. Exported so the over-cap check in
 * `submitFalMotionJob` computes the same reference budget the builder does —
 * the two disagreeing would mean warning about drops that never happened, or
 * missing the ones that did.
 */
export function pinsDedicatedStartFrame(
  endpointId: MotionEndpointId,
  options: Pick<GenerateMotionOptions, 'imageUrl' | 'referenceOnly'>
): boolean {
  return (
    !options.referenceOnly &&
    Boolean(options.imageUrl) &&
    hasStartFrameField(MOTION_JSON_SCHEMAS[endpointId])
  );
}

export function buildMotionRequest<T extends ImageToVideoModel>(
  options: GenerateMotionOptions,
  modelKey: T
): {
  endpointId: string;
  input: ModelOutputMap[T] | RegisteredMotionOutput;
} {
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];
  // "Has references" means references this endpoint can actually carry
  // (#1559): a shot whose only attachment is an audio clip has nothing to send
  // a reference-to-video endpoint, which rejects an empty image list.
  const endpoint = resolveMotionEndpoint(
    modelKey,
    bindableReferences(
      getMotionReferenceEndpoint(modelKey),
      options.referenceImages ?? [],
      Boolean(options.imageUrl)
    ).length > 0,
    'fal',
    options.referenceOnly ?? false
  );

  if (endpoint.references === 'text-to-video') {
    if (options.imageUrl) {
      // The prompt-only route has nowhere to put a still. Reaching here with
      // one means a caller set `referenceOnly` on a shot that rendered a
      // frame; dropping it silently would return a different kind of clip.
      throw new Error(
        `Motion model "${modelKey}" was given a start frame in reference-only mode`
      );
    }
    const { endpointId } = endpoint;
    const input = MOTION_TRANSFORMS[endpointId].parse({
      prompt: options.prompt,
      duration: options.duration,
      aspectRatio: options.aspectRatio,
      ...QUALITY_OVERRIDES[modelKey],
      ...resolutionOverride(endpointId, options.resolution),
      generate_audio:
        options.generateAudio ?? videoModelSupportsAudio(modelKey),
      ...(options.multiPrompt &&
        options.multiPrompt.length > 0 && {
          multi_prompt: options.multiPrompt,
          shot_type: 'customize',
        }),
    });
    return {
      endpointId,
      input: applyKlingMultiPrompt(input, options.multiPrompt),
    };
  }

  if (endpoint.references !== 'endpoint') {
    if (!options.imageUrl) {
      // Only reachable if a reference-only shot reached a non-reference route,
      // which `resolveMotionEndpoint` already refuses to return. Assert it
      // anyway so the failure names the cause rather than surfacing as a
      // provider 422 on a missing `image_url`.
      throw new Error(
        `Motion model "${modelKey}" requires a start frame but none was provided`
      );
    }
    return {
      endpointId: endpoint.endpointId,
      input: buildModelInput(options, modelConfig, modelKey),
    };
  }

  const endpointId = endpoint.referenceConfig.endpointId;
  const transform = MOTION_TRANSFORMS[endpointId];

  if (!options.imageUrl && !options.referenceOnly) {
    // The reference-to-video endpoint accepts a request with no still, so a
    // missing one here would silently render reference-only instead of
    // failing — a shot whose image generation died would quietly come back as
    // a different kind of clip. Only the explicit mode may omit the still.
    throw new Error(
      `Motion model "${modelKey}" was given no start frame outside reference-only mode`
    );
  }

  const pinsStartFrame = pinsDedicatedStartFrame(endpointId, options);

  const { prompt, imageUrls, videoUrls, audioUrls } = buildReferenceVideoPrompt(
    endpoint.referenceConfig,
    options.prompt,
    // Pinned in its own field, the still is not part of the image list: the
    // binding is then exactly the reference-only shape — sheets from slot 1,
    // no "Use @Image1 as the starting frame." line, because the frame is
    // guaranteed by the request rather than asked for in prose.
    pinsStartFrame ? null : (options.imageUrl ?? null),
    options.referenceImages ?? [],
    modelConfig.maxPromptLength
  );

  const config = endpoint.referenceConfig;
  const imageField = config.imageField ?? 'image_urls';

  const input = transform.parse({
    prompt,
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    // Never empty here unless clips carry the shot instead: a reference-only
    // shot with nothing bindable resolved to the text-to-video branch above,
    // because fal rejects a request with no reference image OR video.
    [imageField]: imageUrls,
    // The transform maps `imageUrl` onto the schema's start-frame field
    // (`start_image_url` on Kling O3, the only reference endpoint with one).
    ...(pinsStartFrame && { imageUrl: options.imageUrl }),
    ...(videoUrls.length > 0 && {
      [config.videoField ?? 'video_urls']: videoUrls,
    }),
    ...(audioUrls.length > 0 && {
      [config.audioField ?? 'audio_urls']: audioUrls,
    }),
    ...QUALITY_OVERRIDES[modelKey],
    ...resolutionOverride(endpointId, options.resolution),
    generate_audio: options.generateAudio ?? videoModelSupportsAudio(modelKey),
    ...(options.multiPrompt &&
      options.multiPrompt.length > 0 && {
        multi_prompt: options.multiPrompt,
        shot_type: 'customize',
      }),
  });

  return {
    endpointId: endpoint.endpointId,
    input: applyKlingMultiPrompt(input, options.multiPrompt),
  };
}
