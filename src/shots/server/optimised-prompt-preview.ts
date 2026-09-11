/**
 * Assembled request the scene editor's optimised-prompt inspector shows
 * (#1242). Same builders submit uses, so the JSON cannot drift — but the
 * browser must not run them. `previewShotPromptsFn` is the only client
 * entry; this module is server-only.
 */

import type { AssemblableMotionPrompt } from '@/shots/scene-analysis.schema';
import { isBytePlusConfigured } from '@/models/server/byteplus-config';
import { toCdnUrl } from '@/platform/server/storage/buckets';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import { isNativeGeminiVideoModel } from '@/models/gemini-native';
import { isNativeGrokVideoModel } from '@/models/grok-native';
import {
  getBytePlusImageModelId,
  getBytePlusVideoModelId,
  getMotionReferenceEndpoint,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import { buildBytePlusImageRequest } from '@/stills/build-byteplus-image-request';
import { buildImageRequest } from '@/stills/build-image-request';
import { buildBytePlusVideoRequest } from '@/motion/server/build-byteplus-video-request';
import { buildGeminiVideoRequest } from '@/motion/server/build-gemini-video-request';
import { buildGrokVideoRequest } from '@/motion/server/build-grok-video-request';
import { buildMotionRequest } from '@/motion/server/build-model-input';
import {
  buildMotionReferenceImages,
  buildShotImageReferenceImages,
} from '@/motion/server/build-motion-references';
import { resolveMotionPrompt } from '@/motion/server/resolve-motion-prompt';
import {
  missingVoiceLines,
  unusableShotReferenceLines,
} from '@/motion/reference-support';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import { buildReferenceImagePrompt } from '@/stills/reference-image-prompt';

export type BoundPromptImage = {
  label: string;
  url: string;
};

export type OptimisedPromptPreview = {
  modelName: string;
  endpointId: string;
  prompt: string;
  json: string | null;
  promptLength: number;
  maxPromptLength: number;
  images?: BoundPromptImage[];
  /**
   * Reference clips and audio riding the request (#1559), each labelled with
   * the tag the prompt binds it by — the same `@Video1` / `Audio 1` the
   * provider reads, so the preview is the request and not an approximation.
   */
  videos?: BoundPromptImage[];
  audio?: BoundPromptImage[];
};

export type ShotPromptPreview = {
  image: OptimisedPromptPreview | null;
  motion: OptimisedPromptPreview | null;
  /**
   * Why submit would refuse this shot on this model (#1559) — the same lines,
   * from the same references and start-frame state, so the warning before
   * Generate is exactly the refusal it prevents. Empty when it would render.
   */
  motionUnusable: string[];
  assembledMotionPrompt: string | null;
  motionHasReferenceImages: boolean;
};

type SceneReferenceInput = {
  continuity?: {
    characterTags?: string[];
    elementTags?: string[] | null;
    environmentTag?: string | null;
  } | null;
  originalScript?: { extract?: string } | null;
  metadata?: { location?: string } | null;
} | null;

export function boundPromptImages(
  urls: readonly string[],
  tag: (position: number) => string
): BoundPromptImage[] {
  return urls
    .filter((url) => url.length > 0)
    .map((url, index) => ({ label: tag(index + 1), url }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function imageUrlsFromFalInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) urls.push(value);
  };
  if (Array.isArray(input.image_urls)) {
    for (const url of input.image_urls) push(url);
  } else if (Array.isArray(input.reference_image_urls)) {
    for (const url of input.reference_image_urls) push(url);
  } else {
    push(input.image_url);
    push(input.start_image_url);
  }
  if (Array.isArray(input.elements)) {
    for (const element of input.elements) {
      if (isRecord(element)) push(element.frontal_image_url);
    }
  }
  return urls;
}

/** The URL list in the first of `fields` the fal input carries. */
function falUrlList(input: unknown, fields: readonly string[]): string[] {
  if (!isRecord(input)) return [];
  for (const field of fields) {
    const value = input[field];
    if (Array.isArray(value)) {
      return value.filter(
        (url): url is string => typeof url === 'string' && url.length > 0
      );
    }
  }
  return [];
}

export function imageUrlsFromPromptParts(
  parts: unknown,
  type: 'image' | 'video' | 'audio' = 'image'
): string[] {
  if (!Array.isArray(parts)) return [];
  const urls: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== type || !isRecord(part.source)) {
      continue;
    }
    if (typeof part.source.value === 'string' && part.source.value.length > 0) {
      urls.push(part.source.value);
    }
  }
  return urls;
}

export function promptFromFalInput(input: unknown, fallback: string): string {
  if (
    input !== null &&
    typeof input === 'object' &&
    'prompt' in input &&
    typeof input.prompt === 'string'
  ) {
    return input.prompt;
  }
  return fallback;
}

function absolutizePreviewUrl(url: string): string {
  return toCdnUrl(url) ?? url;
}

function absolutizeRefs<T extends { referenceImageUrl: string }>(
  refs: T[]
): T[] {
  return refs.map((ref) => ({
    ...ref,
    referenceImageUrl: absolutizePreviewUrl(ref.referenceImageUrl),
  }));
}

export function buildShotPromptPreview(input: {
  imageModel: TextToImageModel;
  videoModel: ImageToVideoModel;
  imagePrompt: string;
  motionPrompt: AssemblableMotionPrompt | null;
  shotDurationMs: number | null;
  startFrameUrl: string | null;
  usesStartFrame: boolean;
  generateAudio: boolean;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  scene: SceneReferenceInput;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
  locations: SequenceLocationMinimal[];
  byteplusEnabled?: boolean;
}): ShotPromptPreview {
  const byteplusEnabled = input.byteplusEnabled ?? isBytePlusConfigured();
  const assembledMotionPrompt = resolveMotionPrompt(
    {
      motionPrompt: input.motionPrompt,
      characterTags: input.scene?.continuity?.characterTags,
      description: input.scene?.originalScript?.extract ?? null,
      generateAudio: input.generateAudio,
    },
    input.videoModel
  );
  const motionRefs = absolutizeRefs(
    buildMotionReferenceImages({
      scene: input.scene,
      characters: input.characters,
      elements: input.elements,
      // The ASSEMBLED prompt, exactly as submit passes it (#1559). A voice
      // bound to a dialogue line is named only in what assembly appends, so
      // matching the raw text dropped it here while submit sent it — the
      // preview showed `MATEO_SHOT_1` where the provider got `Audio 1`.
      motionPrompt: assembledMotionPrompt,
      includeLocations: !input.usesStartFrame,
      locations: input.locations,
    })
  );

  return {
    image: buildImagePreview({
      model: input.imageModel,
      prompt: input.imagePrompt,
      scene: input.scene,
      characters: input.characters,
      elements: input.elements,
      locations: input.locations,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      byteplusEnabled,
    }),
    motion: buildMotionPreview({
      model: input.videoModel,
      assembledPrompt: assembledMotionPrompt,
      shotDurationMs: input.shotDurationMs,
      startFrameUrl: input.startFrameUrl,
      usesStartFrame: input.usesStartFrame,
      generateAudio: input.generateAudio,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: motionRefs,
      byteplusEnabled,
    }),
    assembledMotionPrompt,
    motionHasReferenceImages: motionRefs.length > 0,
    motionUnusable: [
      ...unusableShotReferenceLines(
        input.videoModel,
        motionRefs,
        input.usesStartFrame
      ),
      ...missingVoiceLines(
        input.videoModel,
        input.motionPrompt?.dialogue,
        input.elements
      ),
    ],
  };
}

function buildImagePreview(input: {
  model: TextToImageModel;
  prompt: string;
  scene: SceneReferenceInput;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
  locations: SequenceLocationMinimal[];
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  byteplusEnabled: boolean;
}): OptimisedPromptPreview | null {
  const basePrompt = input.prompt.trim();
  if (!basePrompt) return null;
  const config = IMAGE_MODELS[input.model];
  const referenceImages = absolutizeRefs(
    buildShotImageReferenceImages({
      scene: input.scene,
      visualPrompt: basePrompt,
      characters: input.characters,
      locations: input.locations,
      elements: input.elements,
    })
  );
  try {
    const { prompt: enhancedPrompt, referenceUrls } = buildReferenceImagePrompt(
      basePrompt,
      referenceImages,
      config.maxPromptLength
    );
    const buildParams = {
      model: input.model,
      prompt: enhancedPrompt,
      imageSize: input.aspectRatio
        ? aspectRatioToImageSize(input.aspectRatio)
        : undefined,
      resolution: input.resolution,
      numImages: 1,
      referenceImageUrls: referenceUrls,
    };
    if (
      input.byteplusEnabled &&
      getBytePlusImageModelId(input.model) !== undefined
    ) {
      const { modelId, ...body } = buildBytePlusImageRequest(buildParams);
      return {
        modelName: config.name,
        endpointId: modelId,
        prompt: enhancedPrompt,
        json: JSON.stringify(body, null, 2),
        promptLength: enhancedPrompt.length,
        maxPromptLength: config.maxPromptLength,
        images: boundPromptImages(
          referenceUrls,
          (position) => `Image ${position}`
        ),
      };
    }
    const request = buildImageRequest(buildParams);
    const falImageUrls = imageUrlsFromFalInput(request.input);
    return {
      modelName: config.name,
      endpointId: request.endpointId,
      prompt: promptFromFalInput(request.input, enhancedPrompt),
      json: JSON.stringify(request.input, null, 2),
      promptLength: enhancedPrompt.length,
      maxPromptLength: config.maxPromptLength,
      images: boundPromptImages(
        falImageUrls.length > 0 ? falImageUrls : referenceUrls,
        (position) => `Image ${position}`
      ),
    };
  } catch {
    return null;
  }
}

function buildMotionPreview(input: {
  model: ImageToVideoModel;
  assembledPrompt: string | null;
  shotDurationMs: number | null;
  startFrameUrl: string | null;
  usesStartFrame: boolean;
  generateAudio: boolean;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  referenceImages: ReturnType<typeof buildMotionReferenceImages>;
  byteplusEnabled: boolean;
}): OptimisedPromptPreview | null {
  const modelPrompt = input.assembledPrompt;
  if (!modelPrompt) return null;
  const config = IMAGE_TO_VIDEO_MODELS[input.model];
  const duration = resolveShotDuration({
    explicit: undefined,
    durationMs: input.shotDurationMs,
    model: input.model,
  });
  const imageUrl = input.usesStartFrame
    ? absolutizePreviewUrl(input.startFrameUrl ?? '')
    : undefined;
  try {
    if (isNativeGrokVideoModel(input.model)) {
      const request = buildGrokVideoRequest({
        prompt: modelPrompt,
        imageUrl,
        duration,
        aspectRatio: input.aspectRatio,
        referenceImages: input.referenceImages,
        model: input.model,
      });
      const textPart = request.input.prompt.find(
        (part) => part.type === 'text'
      );
      const prompt = textPart?.content ?? modelPrompt;
      return {
        modelName: config.name,
        endpointId: request.endpointId,
        prompt,
        json: JSON.stringify(request.input, null, 2),
        promptLength: prompt.length,
        maxPromptLength: config.maxPromptLength,
        images: boundPromptImages(
          imageUrlsFromPromptParts(request.input.prompt),
          (position) => `<IMAGE_${position - 1}>`
        ),
      };
    }
    if (
      input.byteplusEnabled &&
      getBytePlusVideoModelId(input.model) !== undefined
    ) {
      const ark = buildBytePlusVideoRequest(
        {
          prompt: modelPrompt,
          imageUrl,
          duration,
          aspectRatio: input.aspectRatio,
          generateAudio: videoModelSupportsAudio(input.model)
            ? input.generateAudio
            : undefined,
          referenceImages: input.referenceImages,
        },
        input.model
      );
      const { modelId, ...body } = ark;
      const textPart = ark.prompt.find((part) => part.type === 'text');
      const prompt = textPart?.content ?? modelPrompt;
      return {
        modelName: config.name,
        endpointId: modelId,
        prompt,
        json: JSON.stringify(body, null, 2),
        promptLength: prompt.length,
        maxPromptLength: config.maxPromptLength,
        images: boundPromptImages(
          imageUrlsFromPromptParts(ark.prompt),
          (position) => `@Image${position}`
        ),
        videos: boundPromptImages(
          imageUrlsFromPromptParts(ark.prompt, 'video'),
          (position) => `@Video${position}`
        ),
        audio: boundPromptImages(
          imageUrlsFromPromptParts(ark.prompt, 'audio'),
          (position) => `@Audio${position}`
        ),
      };
    }
    if (isNativeGeminiVideoModel(input.model)) {
      const request = buildGeminiVideoRequest({
        prompt: modelPrompt,
        imageUrl,
        duration,
        aspectRatio: input.aspectRatio,
        referenceImages: input.referenceImages,
        model: input.model,
      });
      const textPart = request.input.prompt.find(
        (part) => part.type === 'text'
      );
      const prompt = textPart?.content ?? modelPrompt;
      return {
        modelName: config.name,
        endpointId: request.endpointId,
        prompt,
        json: JSON.stringify(request.input, null, 2),
        promptLength: prompt.length,
        maxPromptLength: config.maxPromptLength,
        images: boundPromptImages(
          imageUrlsFromPromptParts(request.input.prompt),
          (position) => `<IMAGE_REF_${position - 1}>`
        ),
      };
    }
    const request = buildMotionRequest(
      {
        prompt: modelPrompt,
        imageUrl,
        duration,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        generateAudio: videoModelSupportsAudio(input.model)
          ? input.generateAudio
          : undefined,
        referenceImages: input.referenceImages,
        referenceOnly: !input.usesStartFrame,
      },
      input.model
    );
    // Label with the tags of the endpoint the request actually hit: H3 Max
    // binds `Image 1` / `Audio 1`, Seedance `@Image1` / `@Audio1`. A label
    // the prompt does not use would make the preview lie about the binding.
    const refConfig = getMotionReferenceEndpoint(input.model);
    const onRefEndpoint = refConfig?.endpointId === request.endpointId;
    return {
      modelName: config.name,
      endpointId: request.endpointId,
      prompt: promptFromFalInput(request.input, modelPrompt),
      json: JSON.stringify(request.input, null, 2),
      promptLength: modelPrompt.length,
      maxPromptLength: config.maxPromptLength,
      images: boundPromptImages(
        imageUrlsFromFalInput(request.input),
        onRefEndpoint && refConfig
          ? refConfig.tag
          : (position) => `@Image${position}`
      ),
      videos: boundPromptImages(
        falUrlList(request.input, ['video_urls', 'reference_video_urls']),
        refConfig?.videoTag ?? ((position) => `@Video${position}`)
      ),
      audio: boundPromptImages(
        falUrlList(request.input, ['audio_urls', 'reference_audio_urls']),
        refConfig?.audioTag ?? ((position) => `@Audio${position}`)
      ),
    };
  } catch {
    return null;
  }
}
