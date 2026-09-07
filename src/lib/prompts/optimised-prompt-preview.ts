/**
 * Assembled request the scene editor's optimised-prompt inspector shows
 * (#1242). Same builders submit uses, so the JSON cannot drift — but the
 * browser must not run them. `previewShotPromptsFn` is the only client
 * entry; this module is server-only.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import { isBytePlusConfigured } from '@/lib/ai/byteplus-config';
import { toCdnUrl } from '@/lib/storage/buckets';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { isNativeGeminiVideoModel } from '@/shared/ai/gemini-native';
import { isNativeGrokVideoModel } from '@/shared/ai/grok-native';
import {
  getBytePlusImageModelId,
  getBytePlusVideoModelId,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/shared/ai/models';
import {
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/shared/constants/aspect-ratios';
import type { Resolution } from '@/shared/constants/resolutions';
import { buildBytePlusImageRequest } from '@/shared/image/build-byteplus-image-request';
import { buildImageRequest } from '@/shared/image/build-image-request';
import { buildBytePlusVideoRequest } from '@/shared/motion/build-byteplus-video-request';
import { buildGeminiVideoRequest } from '@/shared/motion/build-gemini-video-request';
import { buildGrokVideoRequest } from '@/shared/motion/build-grok-video-request';
import { buildMotionRequest } from '@/shared/motion/build-model-input';
import {
  buildMotionReferenceImages,
  buildShotImageReferenceImages,
} from '@/shared/motion/build-motion-references';
import { resolveMotionPrompt } from '@/shared/motion/resolve-motion-prompt';
import { resolveShotDuration } from '@/shared/motion/resolve-shot-duration';
import { buildReferenceImagePrompt } from '@/shared/prompts/reference-image-prompt';

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
};

export type ShotPromptPreview = {
  image: OptimisedPromptPreview | null;
  motion: OptimisedPromptPreview | null;
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

export function imageUrlsFromPromptParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const urls: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== 'image' || !isRecord(part.source)) {
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
  motionPromptText: string | null;
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
      motionPrompt: input.motionPromptText,
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
    return {
      modelName: config.name,
      endpointId: request.endpointId,
      prompt: promptFromFalInput(request.input, modelPrompt),
      json: JSON.stringify(request.input, null, 2),
      promptLength: modelPrompt.length,
      maxPromptLength: config.maxPromptLength,
      images: boundPromptImages(
        imageUrlsFromFalInput(request.input),
        (position) => `@Image${position}`
      ),
    };
  } catch {
    return null;
  }
}
