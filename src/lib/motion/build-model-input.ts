/**
 * Schema-Driven Model Input Builder
 *
 * Builds the fal.ai request body for a video model using generated
 * Zod transforms. Each transform accepts our internal camelCase format
 * (numeric duration, imageUrl) and produces the API's snake_case format
 * with correctly-typed duration values.
 */

import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/lib/ai/models';
import type { z } from 'zod';
import { buildKlingElementsInput } from './build-kling-elements';
import { buildReferenceVideoPrompt } from './build-reference-video-prompt';
import {
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/lib/prompts/reference-legend';
import {
  pickVideoResolution,
  tiersForTokens,
  type Resolution,
} from '@/lib/constants/resolutions';
import {
  MOTION_JSON_SCHEMAS,
  MOTION_TRANSFORMS,
  type MotionEndpointId,
} from './endpoint-map';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';
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
 * schema. Empty for an endpoint with no such field (Kling v3, Hailuo 2.3),
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
 * The tiers a motion model can actually deliver — what the resolution picker
 * offers for it (#1449). Reads the i2v endpoint's enum; the T2V and
 * reference-to-video siblings advertise the same tokens.
 */
export function motionResolutionTiers(model: ImageToVideoModel): Resolution[] {
  return tiersForTokens(
    motionResolutionTokens(IMAGE_TO_VIDEO_MODELS[model].id),
    'video'
  );
}

/**
 * The requested resolution tier (#1449) in the endpoint's own vocabulary —
 * `'768P'` on H3 Max, `'4k'` on Seedance 2.0, `'2160p'` on LTX. Read off the
 * generated fal schema, so a new motion model needs no entry anywhere: it
 * inherits whatever its `resolution` enum advertises, and an endpoint with no
 * such field (Kling v3, Hailuo 2.3) keeps its fixed output.
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
  veo3_1: 'background music, musical score, soundtrack',
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
  // Reference images (#873): only Kling v3 Pro accepts them on this path, via
  // its `elements` field — canonical entity tokens in the prompt are bound
  // inline as `@ElementN`. For every other model the images can't be attached,
  // so tokens are substituted with their bible descriptions instead — a prompt
  // written as "SCARLETT lifts the CORAL_LIPSTICK" stays self-contained. No
  // `elements` key is passed for those models (the apiSchema would strip it
  // anyway).
  const references = options.referenceImages ?? [];
  const kling =
    modelKey === 'kling_v3_pro' && references.length > 0
      ? buildKlingElementsInput(
          options.prompt,
          references,
          modelConfig.maxPromptLength
        )
      : undefined;
  const prompt =
    kling?.prompt ??
    (references.length > 0
      ? substituteReferenceTags(
          options.prompt,
          references.map((ref) => ({
            token: ref.token,
            render: inlineReferenceDescription(ref),
          }))
        ).prompt
      : options.prompt);
  const elements = kling?.elements.length ? kling.elements : undefined;

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion safe to cast here because we know the transform is valid
  const result = transform.parse({
    prompt,
    duration: options.duration,
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio,
    ...QUALITY_OVERRIDES[modelKey],
    ...resolutionOverride(endpointId, options.resolution),
    ...(NO_MUSIC_NEGATIVE_PROMPTS[modelKey] && {
      negative_prompt: NO_MUSIC_NEGATIVE_PROMPTS[modelKey],
    }),
    ...(elements && { elements }),
    // Pass-through `generate_audio` for audio-capable models. The schema-driven
    // transform forwards unknown keys; models without `generate_audio` strip
    // it during apiSchema.parse.
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
  }) as ModelOutputMap[T];

  return result;
}

/** Output of a reference-to-video transform (the endpoints in
 *  `MOTION_REFERENCE_ENDPOINTS`). */
type ReferenceVideoOutput =
  | z.output<
      (typeof MOTION_TRANSFORMS)['bytedance/seedance-2.5/reference-to-video']
    >
  | z.output<
      (typeof MOTION_TRANSFORMS)['bytedance/seedance-2.0/enterprise/v2/reference-to-video']
    >
  | z.output<(typeof MOTION_TRANSFORMS)['minimax/h3-max/reference-to-video']>;

/**
 * Resolve the endpoint and build the exact fal request body for a motion run
 * (#873). Shared by `submitMotionJob` and the scene editor's optimised-prompt
 * preview, so what the user sees is what fal receives — the only difference at
 * submit time is that locally-served `/r2/` URLs are swapped for externally
 * fetchable ones first.
 *
 * When `resolveMotionEndpoint` routes to a dedicated reference-to-video
 * endpoint (Seedance / H3 Max with cast/element refs), the still goes
 * first in the image-list field with the sheets after it — there is no
 * separate start-frame `image_url` on that endpoint.
 */
export function buildMotionRequest<T extends ImageToVideoModel>(
  options: GenerateMotionOptions,
  modelKey: T
): {
  endpointId: string;
  input: ModelOutputMap[T] | ReferenceVideoOutput;
} {
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];
  const endpoint = resolveMotionEndpoint(
    modelKey,
    (options.referenceImages?.length ?? 0) > 0
  );

  if (endpoint.references !== 'endpoint') {
    return {
      endpointId: endpoint.endpointId,
      input: buildModelInput(options, modelConfig, modelKey),
    };
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded below: unregistered endpoints throw
  const endpointId = endpoint.referenceConfig.endpointId as MotionEndpointId;
  const transform = MOTION_TRANSFORMS[endpointId];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- defensive guard for exhaustiveness
  if (!transform) {
    throw new Error(
      `No motion transform registered for reference endpoint: ${endpointId}`
    );
  }

  const { prompt, imageUrls } = buildReferenceVideoPrompt(
    endpoint.referenceConfig,
    options.prompt,
    options.imageUrl,
    options.referenceImages ?? [],
    modelConfig.maxPromptLength
  );

  const imageField = endpoint.referenceConfig.imageField ?? 'image_urls';

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- transform is the reference-to-video schema
  const input = transform.parse({
    prompt,
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    [imageField]: imageUrls,
    ...QUALITY_OVERRIDES[modelKey],
    ...resolutionOverride(endpointId, options.resolution),
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
  }) as ReferenceVideoOutput;

  return { endpointId: endpoint.endpointId, input };
}
