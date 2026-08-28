/**
 * Submit/poll for studio clips. `mode` picks the endpoint: the family's T2V
 * sibling, its reference-to-video sibling, or the sequence image-to-video
 * endpoint (frames).
 */

import { getEnv } from '#env';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/fal-deadline-fetch';
import {
  grokVideoCost,
  isNativeGrokVideoModel,
  NATIVE_GROK_VIDEO_MODEL,
} from '@/lib/ai/grok-native';
import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/lib/ai/models';
import { assertMediaVia, type MediaVia } from '@/lib/ai/via';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { ZERO_MICROS } from '@/lib/billing/money';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import { MOTION_TRANSFORMS } from '@/lib/motion/endpoint-map';
import {
  ensureExternallyFetchableUrls,
  toDataOrCdnUrl,
} from '@/lib/storage/external-url';
import {
  buildStudioVideoInput,
  studioReferenceEndpoint,
  studioVideoEndpointId,
  tagStudioReferences,
  type StudioVideoMode,
  type StudioVideoRequest,
} from '@/lib/studio/text-to-video';
import {
  generateVideo,
  getVideoJobStatus,
  type TokenUsage,
} from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import { createGrokVideo } from '@tanstack/ai-grok';

export type StudioVideoJobOptions = {
  scopedDb?: CredentialScopedDb;
  prompt: string;
  model: ImageToVideoModel;
  duration?: number;
  aspectRatio?: AspectRatio;
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

function createNativeVideoAdapter(apiKey: string) {
  const env = getEnv();
  return createGrokVideo(NATIVE_GROK_VIDEO_MODEL, apiKey, {
    fetch: workersSafeFetch,
    ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
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
      generateAudio: options.generateAudio,
    });
    return {
      endpointId: studioVideoEndpointId(modelKey, mode),
      built: {
        ...built,
        modelOptions: {
          ...built.modelOptions,
          [reference.imageField]: imageUrls,
          ...(videoUrls.length > 0 && { video_urls: videoUrls }),
          ...(audioUrls.length > 0 && { audio_urls: audioUrls }),
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
  const { prompt, ...modelOptions } = transform.parse({
    prompt: options.prompt,
    duration: options.duration,
    aspectRatio: options.aspectRatio,
    imageUrl: urls[0],
    ...(urls[1] && { end_image_url: urls[1] }),
    ...(options.generateAudio !== undefined && {
      generate_audio: options.generateAudio,
    }),
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

export async function submitStudioVideoJob(
  options: StudioVideoJobOptions
): Promise<StudioVideoJobSubmission> {
  const modelKey = options.model;
  const mode = options.mode ?? 'text';
  const size = options.aspectRatio
    ? (`${options.aspectRatio}_720p` as const)
    : undefined;
  const xaiKey = isNativeGrokVideoModel(modelKey)
    ? await resolveOptionalXaiKey(options.scopedDb)
    : undefined;

  // Native Grok takes stills as prompt image parts (`metadata.role`), the
  // same payload the sequence path sends — references tagged `<IMAGE_n>`,
  // or a start frame. Inlined as data URIs so no fal key is needed.
  if (xaiKey && mode !== 'text') {
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
      ...(size && { size }),
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

  // Other image modes go to fal's reference / image-to-video siblings.
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
    generateAudio: options.generateAudio,
  });

  if (xaiKey) {
    const job = await generateVideo({
      adapter: createNativeVideoAdapter(xaiKey.key),
      prompt: built.prompt,
      duration: built.duration,
      ...(size && { size }),
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
    case 'fal': {
      return {
        endpointId: job.endpointId,
        unitsBilled: usage?.unitsBilled,
        cost: await falCostFromUnits(job.endpointId, usage?.unitsBilled),
        recordFalUsage: true,
      };
    }
  }
}
