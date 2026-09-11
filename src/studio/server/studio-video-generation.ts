/**
 * Submit/poll for studio clips. `mode` picks the endpoint: the family's T2V
 * sibling, its reference-to-video sibling, or the sequence image-to-video
 * endpoint (frames).
 */

import { getEnv } from '#env';
import { toArkFetchableUrl } from '@/models/server/byteplus-asset-ingest';
import {
  arkUrlFor,
  type ArkAssetMap,
  type ArkStill,
} from '@/models/server/byteplus-asset-steps';
import {
  arkAdapterConfig,
  claimBytePlusVia,
  getArkApiKey,
  isBytePlusConfigured,
  loadBytePlusVideo,
} from '@/models/server/byteplus-config';
import {
  BYTEPLUS_PORTRAIT_FILTER_MESSAGE,
  isBytePlusPortraitFilterError,
} from '@/models/server/byteplus-portrait-filter';
import { bytePlusVideoUnitsBilled } from '@/billing/byteplus-pricing';
import { withBytePlusQuotaRetry } from '@/models/server/quota-retry';
import { falCostFromUnits } from '@/billing/server/fal-cost-billing';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/models/server/fal-deadline-fetch';
import {
  geminiVideoCostFromUsage,
  isNativeGeminiVideoModel,
  NATIVE_GEMINI_VIDEO_MODEL,
} from '@/models/gemini-native';
import {
  grokVideoCost,
  isNativeGrokVideoModel,
  NATIVE_GROK_VIDEO_MODEL,
} from '@/models/grok-native';
import {
  getBytePlusVideoModelId,
  IMAGE_TO_VIDEO_MODELS,
  isNativeBytePlusVideoModel,
  type ImageToVideoModel,
} from '@/models/models';
import { assertMediaVia, type MediaVia } from '@/models/via';
import { GROK_VIDEO_RESOLUTIONS } from '@/motion/server/build-grok-video-request';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { ZERO_MICROS } from '@/billing/money';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import { MOTION_TRANSFORMS } from '@/motion/server/endpoint-map';
import {
  ensureExternallyFetchableUrls,
  toDataOrCdnUrl,
} from '@/platform/server/storage/external-url';
import {
  buildStudioVideoInput,
  studioReferenceEndpoint,
  studioVideoEndpointId,
  studioVideoResolution,
  tagStudioReferences,
  type StudioVideoMode,
  type StudioVideoRequest,
} from '@/studio/text-to-video';
import { generateVideo, type TokenUsage } from '@tanstack/ai';
import { getVideoJobStatus } from '@/motion/server/video-job-status';
import { falVideo } from '@tanstack/ai-fal';
import { createGeminiVideo } from '@tanstack/ai-gemini';
import { createGrokVideo } from '@tanstack/ai-grok';
import {
  geminiImagePart,
  geminiNativeModelOptions,
  geminiVideoSize,
} from '@/motion/server/build-gemini-video-request';
import {
  getGeminiFileState,
  isGeminiFilesVideoUrl,
} from '@/motion/server/video-storage';

type StudioVideoJobOptions = {
  scopedDb?: CredentialScopedDb;
  prompt: string;
  model: ImageToVideoModel;
  duration?: number;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  generateAudio?: boolean;
  mode?: StudioVideoMode;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudio?: string[];
  startImageUrl?: string;
  endImageUrl?: string;
};

export type StudioVideoJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  endpointId: string;
  via: MediaVia;
  usedOwnKey: boolean;
};

async function resolveFalKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey> {
  if (scopedDb) return scopedDb.resolveKey('fal');
  return { key: getEnv().FAL_KEY, source: 'platform' };
}

async function resolveOptionalXaiKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

async function resolveOptionalFalKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('fal');
  const platformKey = getEnv().FAL_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

function createNativeVideoAdapter(apiKey: string) {
  const env = getEnv();
  return createGrokVideo(NATIVE_GROK_VIDEO_MODEL, apiKey, {
    fetch: workersSafeFetch,
    ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
  });
}

async function resolveOptionalGoogleKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('google');
  const platformKey = getEnv().GEMINI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

function createNativeGeminiVideoAdapter(apiKey: string) {
  const env = getEnv();
  return createGeminiVideo(NATIVE_GEMINI_VIDEO_MODEL, apiKey, {
    ...(env.GEMINI_BASE_URL && {
      httpOptions: { baseUrl: env.GEMINI_BASE_URL },
    }),
  });
}

/**
 * Reference: the T2V body plus the stills/clips/audio fields. Frames: see
 * below. Stored `/r2/` URLs are made fetchable first.
 */
async function buildStudioImageModeInput(
  options: StudioVideoJobOptions,
  modelKey: ImageToVideoModel,
  mode: Exclude<StudioVideoMode, 'text'>,
  falApiKey: string
): Promise<{ endpointId: string; built: StudioVideoRequest }> {
  if (mode === 'reference') {
    // Reference siblings share the T2V body shape (duration / aspect / audio
    // / resolution) plus the stills, so reuse that builder and add the field.
    const reference = studioReferenceEndpoint(modelKey);
    if (!reference) throw new Error(`${modelKey} has no reference endpoint`);
    const [imageUrls, videoUrls, audioUrls] = await Promise.all([
      ensureExternallyFetchableUrls(options.referenceImages ?? [], falApiKey),
      ensureExternallyFetchableUrls(options.referenceVideos ?? [], falApiKey),
      ensureExternallyFetchableUrls(options.referenceAudio ?? [], falApiKey),
    ]);
    const built = buildStudioVideoInput({
      prompt: tagStudioReferences(options.prompt, modelKey),
      model: modelKey,
      duration: options.duration,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      generateAudio: options.generateAudio,
    });
    return {
      endpointId: studioVideoEndpointId(modelKey, mode),
      built: {
        ...built,
        modelOptions: {
          ...built.modelOptions,
          [reference.imageField]: imageUrls,
          ...(videoUrls.length > 0 && {
            [reference.videoField ?? 'video_urls']: videoUrls,
          }),
          ...(audioUrls.length > 0 && {
            [reference.audioField ?? 'audio_urls']: audioUrls,
          }),
        },
      },
    };
  }

  // Frames: the image-to-video endpoints the sequence path already validates
  // against (`MOTION_TRANSFORMS`), so field names, duration encoding and
  // prompt limits come from the generated schemas.
  const endpointId = IMAGE_TO_VIDEO_MODELS[modelKey].id;
  const transform = MOTION_TRANSFORMS[endpointId];
  const stored = [options.startImageUrl, options.endImageUrl].filter(
    (url): url is string => Boolean(url)
  );
  const urls = await ensureExternallyFetchableUrls(stored, falApiKey);
  const resolution = studioVideoResolution(modelKey, options.resolution);
  const { prompt, ...modelOptions } = transform.parse({
    prompt: options.prompt,
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    imageUrl: urls[0],
    ...(urls[1] && { end_image_url: urls[1] }),
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
    ...(resolution && { resolution }),
  });
  return {
    endpointId,
    built: {
      prompt: typeof prompt === 'string' ? prompt : options.prompt,
      duration: options.duration ?? 5,
      modelOptions,
    },
  };
}

async function submitFalStudioVideoJob(
  options: StudioVideoJobOptions,
  modelKey: ImageToVideoModel,
  mode: StudioVideoMode
): Promise<StudioVideoJobSubmission> {
  if (mode !== 'text') {
    const key = await resolveFalKey(options.scopedDb);
    const { endpointId, built } = await buildStudioImageModeInput(
      options,
      modelKey,
      mode,
      key.key
    );
    const job = await generateVideo({
      adapter: falVideo(endpointId, { apiKey: key.key }),
      prompt: built.prompt,
      modelOptions: built.modelOptions,
      timeout: FAL_REQUEST_TIMEOUT_MS,
      debug: false,
    });
    return {
      jobId: job.jobId,
      modelKey,
      endpointId,
      via: 'fal',
      usedOwnKey: key.source === 'team',
    };
  }
  const built = buildStudioVideoInput({
    prompt: options.prompt,
    model: modelKey,
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
  });
  const key = await resolveFalKey(options.scopedDb);
  const endpointId = studioVideoEndpointId(modelKey);
  const job = await generateVideo({
    adapter: falVideo(endpointId, { apiKey: key.key }),
    prompt: built.prompt,
    modelOptions: built.modelOptions,
    timeout: FAL_REQUEST_TIMEOUT_MS,
    debug: false,
  });
  return {
    jobId: job.jobId,
    modelKey,
    endpointId,
    via: 'fal',
    usedOwnKey: key.source === 'team',
  };
}

function urlPart(
  url: string,
  role: 'start_frame' | 'end_frame' | 'reference' | undefined,
  arkAssets: ArkAssetMap
) {
  // Start frame, end frame, and reference stills were all registered by the
  // workflow (`arkStillsForStudio` → `ingestArkAssets`, #1519); a public URL
  // of a photorealistic face 400s, and a still missing from the map throws.
  return {
    type: 'image' as const,
    source: { type: 'url' as const, value: arkUrlFor(arkAssets, url) },
    ...(role && { metadata: { role } }),
  };
}

/**
 * The stills a BytePlus studio submit needs registered: every image the
 * user supplied (they are uploads — any of them may be a face). Videos and
 * audio are not assets.
 */
export function arkStillsForStudio(
  options: Pick<
    StudioVideoJobOptions,
    'mode' | 'referenceImages' | 'startImageUrl' | 'endImageUrl'
  >
): ArkStill[] {
  const mode = options.mode ?? 'text';
  if (mode === 'reference') {
    return (options.referenceImages ?? []).map((storedUrl) => ({
      storedUrl,
      slot: 'library' as const,
    }));
  }
  if (mode === 'frames') {
    return [options.startImageUrl, options.endImageUrl]
      .filter((url): url is string => Boolean(url))
      .map((storedUrl) => ({ storedUrl, slot: 'frame' as const }));
  }
  return [];
}

async function buildStudioBytePlusPrompt(
  options: SubmitStudioVideoOptions,
  mode: StudioVideoMode,
  promptText: string
) {
  if (mode === 'text') return promptText;

  if (mode === 'reference') {
    const falKey = await resolveOptionalFalKey(options.scopedDb);
    const images = (options.referenceImages ?? []).map((url) =>
      urlPart(url, 'reference', options.arkAssets)
    );
    const videos = await Promise.all(
      (options.referenceVideos ?? []).map(async (url) => ({
        type: 'video' as const,
        source: {
          type: 'url' as const,
          value: await toArkFetchableUrl(url, falKey?.key),
        },
      }))
    );
    const audios = await Promise.all(
      (options.referenceAudio ?? []).map(async (url) => ({
        type: 'audio' as const,
        source: {
          type: 'url' as const,
          value: await toArkFetchableUrl(url, falKey?.key),
        },
      }))
    );
    return [
      { type: 'text' as const, content: promptText },
      ...images,
      ...videos,
      ...audios,
    ];
  }

  // Frames: start_frame + optional last_frame. Mix-ban: no reference roles.
  if (!options.startImageUrl) {
    throw new Error('Studio image-to-video needs a start frame');
  }
  const frames = [
    urlPart(options.startImageUrl, 'start_frame', options.arkAssets),
  ];
  if (options.endImageUrl) {
    frames.push(urlPart(options.endImageUrl, 'end_frame', options.arkAssets));
  }
  return [{ type: 'text' as const, content: promptText }, ...frames];
}

/** Submitting needs the registered stills (#1519); estimating does not. */
export type SubmitStudioVideoOptions = StudioVideoJobOptions & {
  /** From `ingestArkAssets` over `arkStillsForStudio` — see `SubmitMotionOptions.arkAssets`. */
  arkAssets: ArkAssetMap;
};

export async function submitStudioVideoJob(
  options: SubmitStudioVideoOptions
): Promise<StudioVideoJobSubmission> {
  const modelKey = options.model;
  const mode = options.mode ?? 'text';
  // The tier resolves to whatever token the model advertises (#1449). Only the
  // xAI via spells the size `<ratio>_<resolution>` — the fal via sends a bare
  // `resolution` and Ark's image mode sends `adaptive_<resolution>`.
  const tier = studioVideoResolution(modelKey, options.resolution);
  // Narrowed by lookup rather than asserted — xAI's `size` template only
  // admits the three tiers Imagine serves.
  const grokTier = GROK_VIDEO_RESOLUTIONS.find((r) => r === tier) ?? '720p';
  const grokSize = options.aspectRatio
    ? (`${options.aspectRatio}_${grokTier}` as const)
    : undefined;
  // Seedance 2.5 first-frame / first-last-frame rejects a concrete ratio;
  // output follows the first still. Text-to-video can still pick one.
  const arkSize =
    mode === 'text'
      ? options.aspectRatio && `${options.aspectRatio}_${tier ?? '720p'}`
      : `adaptive_${tier ?? '720p'}`;

  // Same claim order as sequence motion: xAI, then Google, then Ark, then
  // fal.
  const xaiKey = isNativeGrokVideoModel(modelKey)
    ? await resolveOptionalXaiKey(options.scopedDb)
    : undefined;
  const googleKey = isNativeGeminiVideoModel(modelKey)
    ? await resolveOptionalGoogleKey(options.scopedDb)
    : undefined;
  let via: MediaVia;
  if (xaiKey) {
    via = 'xai';
  } else if (googleKey) {
    via = 'google';
  } else if (isNativeBytePlusVideoModel(modelKey) && isBytePlusConfigured()) {
    const falKey = await resolveOptionalFalKey(options.scopedDb);
    via = claimBytePlusVia({
      native: true,
      usingOwnFalKey: falKey?.source === 'team',
    });
  } else {
    via = 'fal';
  }

  const geminiSize =
    via === 'google' ? geminiVideoSize(options.aspectRatio) : undefined;

  switch (via) {
    case 'xai': {
      if (!xaiKey) {
        throw new Error('xAI studio via selected with no xAI key');
      }
      // Native Grok takes stills as prompt image parts (`metadata.role`), the
      // same payload the sequence path sends — references tagged `<IMAGE_n>`,
      // or a start frame. Inlined as data URIs so no fal key is needed.
      if (mode !== 'text') {
        const built = buildStudioVideoInput({
          prompt: tagStudioReferences(options.prompt, modelKey),
          model: modelKey,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
        });
        const images =
          mode === 'reference'
            ? (options.referenceImages ?? []).map((url) => ({
                url,
                role: 'reference' as const,
              }))
            : [options.startImageUrl].flatMap((url) =>
                url ? [{ url, role: 'start_frame' as const }] : []
              );
        const parts = [
          { type: 'text' as const, content: built.prompt },
          ...(await Promise.all(
            images.map(async (image) => ({
              type: 'image' as const,
              source: {
                type: 'url' as const,
                value: await toDataOrCdnUrl(image.url),
              },
              metadata: { role: image.role },
            }))
          )),
        ];
        const job = await generateVideo({
          adapter: createNativeVideoAdapter(xaiKey.key),
          prompt: parts,
          duration: built.duration,
          ...(grokSize && { size: grokSize }),
          timeout: FAL_REQUEST_TIMEOUT_MS,
          debug: false,
        });
        return {
          jobId: job.jobId,
          modelKey,
          endpointId: NATIVE_GROK_VIDEO_MODEL,
          via: 'xai',
          usedOwnKey: xaiKey.source === 'team',
        };
      }
      const built = buildStudioVideoInput({
        prompt: options.prompt,
        model: modelKey,
        duration: options.duration,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        generateAudio: options.generateAudio,
      });
      const job = await generateVideo({
        adapter: createNativeVideoAdapter(xaiKey.key),
        prompt: built.prompt,
        duration: built.duration,
        ...(grokSize && { size: grokSize }),
        timeout: FAL_REQUEST_TIMEOUT_MS,
        debug: false,
      });
      return {
        jobId: job.jobId,
        modelKey,
        endpointId: NATIVE_GROK_VIDEO_MODEL,
        via: 'xai',
        usedOwnKey: xaiKey.source === 'team',
      };
    }
    case 'google': {
      if (!googleKey) {
        throw new Error('Google studio via selected with no Google key');
      }
      // Native Gemini Omni Flash takes stills as prompt image parts bound in
      // the prompt by `<IMAGE_REF_n>` tags, with the Interactions task pinned
      // so reference vs frames is never left to the model's inference.
      // Inlined as data URIs so no fal key is needed.
      if (mode !== 'text') {
        const built = buildStudioVideoInput({
          prompt: tagStudioReferences(options.prompt, modelKey),
          model: modelKey,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
        });
        const imageUrls =
          mode === 'reference'
            ? (options.referenceImages ?? [])
            : [options.startImageUrl].filter((url): url is string =>
                Boolean(url)
              );
        const parts = [
          ...(await Promise.all(
            imageUrls.map(async (url) =>
              geminiImagePart(await toDataOrCdnUrl(url))
            )
          )),
          { type: 'text' as const, content: built.prompt },
        ];
        const job = await generateVideo({
          adapter: createNativeGeminiVideoAdapter(googleKey.key),
          prompt: parts,
          modelOptions: geminiNativeModelOptions(
            mode === 'reference' ? 'reference_to_video' : 'image_to_video',
            built.duration,
            geminiSize
          ),
          timeout: FAL_REQUEST_TIMEOUT_MS,
          debug: false,
        });
        return {
          jobId: job.jobId,
          modelKey,
          endpointId: NATIVE_GEMINI_VIDEO_MODEL,
          via: 'google',
          usedOwnKey: googleKey.source === 'team',
        };
      }
      const built = buildStudioVideoInput({
        prompt: options.prompt,
        model: modelKey,
        duration: options.duration,
        aspectRatio: options.aspectRatio,
        generateAudio: options.generateAudio,
      });
      const job = await generateVideo({
        adapter: createNativeGeminiVideoAdapter(googleKey.key),
        prompt: built.prompt,
        modelOptions: geminiNativeModelOptions(
          'text_to_video',
          built.duration,
          geminiSize
        ),
        timeout: FAL_REQUEST_TIMEOUT_MS,
        debug: false,
      });
      return {
        jobId: job.jobId,
        modelKey,
        endpointId: NATIVE_GEMINI_VIDEO_MODEL,
        via: 'google',
        usedOwnKey: googleKey.source === 'team',
      };
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error('ARK_API_KEY is required for the BytePlus studio via');
      }
      const modelId = getBytePlusVideoModelId(modelKey);
      if (!modelId) {
        throw new Error(`No BytePlus model id for motion model "${modelKey}"`);
      }
      const promptText =
        mode === 'reference'
          ? tagStudioReferences(options.prompt, modelKey)
          : options.prompt;
      const built = buildStudioVideoInput({
        prompt: promptText,
        model: modelKey,
        duration: options.duration,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        generateAudio: options.generateAudio,
      });
      const prompt = await buildStudioBytePlusPrompt(
        options,
        mode,
        built.prompt
      );
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_REQUEST_TIMEOUT_MS
      );
      const createBytePlusVideo = await loadBytePlusVideo();
      try {
        const job = await withBytePlusQuotaRetry('studio motion submit', () =>
          generateVideo({
            adapter: createBytePlusVideo(modelId, apiKey, config),
            prompt,
            duration: built.duration,
            ...(arkSize && { size: arkSize }),
            modelOptions: {
              watermark: false,
              ...(options.generateAudio !== undefined && {
                generate_audio: options.generateAudio,
              }),
            },
            timeout: FAL_REQUEST_TIMEOUT_MS,
            debug: false,
          })
        );
        return {
          jobId: job.jobId,
          modelKey,
          endpointId: modelId,
          via: 'byteplus',
          usedOwnKey: false,
        };
      } catch (error) {
        // No fal fallback (#1519): an Ark rejection is the failure the user
        // sees and retries against.
        if (isBytePlusPortraitFilterError(error)) {
          throw new Error(BYTEPLUS_PORTRAIT_FILTER_MESSAGE, { cause: error });
        }
        throw error;
      }
    }
    case 'fal': {
      return submitFalStudioVideoJob(options, modelKey, mode);
    }
  }
}

export async function pollStudioVideoJob(
  job: Pick<StudioVideoJobSubmission, 'jobId' | 'via' | 'endpointId'>,
  scopedDb?: CredentialScopedDb
) {
  const via = assertMediaVia(job.via);
  switch (via) {
    case 'xai': {
      const key = await resolveOptionalXaiKey(scopedDb);
      if (!key) {
        throw new Error(
          `Studio video job ${job.jobId} was submitted to xAI but no xAI key is available to poll it`
        );
      }
      return getVideoJobStatus({
        adapter: createNativeVideoAdapter(key.key),
        jobId: job.jobId,
      });
    }
    case 'fal': {
      const key = await resolveFalKey(scopedDb);
      return getVideoJobStatus({
        adapter: falVideo(job.endpointId, {
          apiKey: key.key,
          fetch: createDeadlineFetch(
            FAL_REQUEST_TIMEOUT_MS,
            'Studio video job status'
          ),
        }),
        jobId: job.jobId,
      });
    }
    case 'google': {
      const key = await resolveOptionalGoogleKey(scopedDb);
      if (!key) {
        throw new Error(
          `Studio video job ${job.jobId} was submitted to Google but no Google key is available to poll it`
        );
      }
      const result = await getVideoJobStatus({
        adapter: createNativeGeminiVideoAdapter(key.key),
        jobId: job.jobId,
      });
      if (
        result.status === 'completed' &&
        result.url &&
        isGeminiFilesVideoUrl(result.url)
      ) {
        const fileState = await getGeminiFileState(result.url, key.key);
        if (fileState === 'FAILED') {
          return {
            ...result,
            status: 'failed' as const,
            error: 'Gemini Files API marked the generated video as FAILED',
          };
        }
        if (fileState !== 'ACTIVE') {
          return { jobId: result.jobId, status: 'processing' as const };
        }
      }
      return result;
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error(
          `Studio video job ${job.jobId} was submitted to BytePlus but no ARK_API_KEY is available to poll it`
        );
      }
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_REQUEST_TIMEOUT_MS
      );
      const createBytePlusVideo = await loadBytePlusVideo();
      return withBytePlusQuotaRetry('studio motion poll', () =>
        getVideoJobStatus({
          adapter: createBytePlusVideo(job.endpointId, apiKey, config),
          jobId: job.jobId,
        })
      );
    }
  }
}

export async function studioVideoCostFromUsage(
  job: Pick<StudioVideoJobSubmission, 'via' | 'endpointId' | 'modelKey'>,
  usage: TokenUsage | undefined
) {
  switch (job.via) {
    case 'xai': {
      const cost = grokVideoCost(usage?.cost);
      if (cost === undefined) {
        reportMissingBillingCost({
          source: 'studio-video-cost-from-usage-xai',
          modelId: job.modelKey,
          metadata: { usage },
        });
      }
      return {
        endpointId: NATIVE_GROK_VIDEO_MODEL,
        unitsBilled: usage?.unitsBilled,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'google': {
      const cost = geminiVideoCostFromUsage(usage);
      if (cost === undefined) {
        reportMissingBillingCost({
          source: 'studio-video-cost-from-usage-google',
          modelId: job.modelKey,
          metadata: { usage },
        });
      }
      return {
        endpointId: NATIVE_GEMINI_VIDEO_MODEL,
        unitsBilled: usage?.unitsBilled,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'fal': {
      return {
        endpointId: job.endpointId,
        unitsBilled: usage?.unitsBilled,
        cost: await falCostFromUnits(job.endpointId, usage?.unitsBilled),
        recordFalUsage: true,
      };
    }
    case 'byteplus': {
      const unitsBilled = bytePlusVideoUnitsBilled(usage?.totalTokens);
      return {
        endpointId: job.endpointId,
        unitsBilled,
        cost: await falCostFromUnits(job.endpointId, unitsBilled),
        recordFalUsage: false,
      };
    }
  }
}
