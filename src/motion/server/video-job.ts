/**
 * One video job for motion and studio: sent direct or through the `openstory`
 * gateway, polled on its stamped via, priced from usage on a direct via
 * (docs/architecture/media-vias.md § The openstory via).
 */

import { getEnv } from '#env';
import { billedFields } from '@/billing/billed-quantity';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { bytePlusVideoUnitsBilled } from '@/billing/byteplus-pricing';
import { ZERO_MICROS } from '@/billing/money';
import { falCostFromUnits } from '@/billing/server/fal-cost-billing';
import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import { openstoryVideo, openstoryVideoStatus } from '@/gateway/server/adapter';
import {
  inProcessGateway,
  inProcessPoller,
  releaseInProcessJob,
} from '@/gateway/server/adapter/in-process';
import type { GatewayStore } from '@/gateway/server/phases';
import {
  gatewayRunRoute,
  resolveGatewayRoutes,
  type GatewayRouteTarget,
  type GatewayRoutes,
} from '@/gateway/server/route';
import { UPLOAD_RIGHTS_CHECKED } from '@/gateway/server/submit-job';
import {
  geminiVideoCostFromUsage,
  NATIVE_GEMINI_VIDEO_MODEL,
} from '@/models/gemini-native';
import { grokVideoCost, NATIVE_GROK_VIDEO_MODEL } from '@/models/grok-native';
import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/models/models';
import {
  arkAdapterConfig,
  getArkApiKey,
  loadBytePlusVideo,
} from '@/models/server/byteplus-config';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/models/server/fal-deadline-fetch';
import { resolveGoogleKeyForStampedJob } from '@/models/server/google-key';
import { withBytePlusQuotaRetry } from '@/models/server/quota-retry';
import { assertMediaVia, type MediaVia, type ProductVia } from '@/models/via';
import { getLogger } from '@/platform/logger';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';
import type {
  CredentialScopedDb,
  WorkflowScopedDb,
} from '@/platform/server/db/scoped-workflow';
import { generateVideo, type TokenUsage } from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import { createGeminiVideo } from '@tanstack/ai-gemini';
import { createGrokVideo } from '@tanstack/ai-grok';
import { z } from 'zod';
import { getVideoJobStatus } from './video-job-status';
import { getGeminiFileState, isGeminiFilesVideoUrl } from './video-storage';

const logger = getLogger(['openstory', 'motion', 'video-job']);

export async function resolveFalKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey> {
  if (credentials) return credentials.resolveKey('fal');
  return { key: getEnv().FAL_KEY, source: 'platform' };
}

export async function resolveOptionalFalKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('fal');
  const platformKey = getEnv().FAL_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

/** Undefined when no xAI key exists. */
export async function resolveOptionalXaiKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

/** `fetch` is set only to capture the body (`sendVideoJob`). */
export function createNativeGrokVideoAdapter(
  apiKey: string,
  fetch: typeof globalThis.fetch = workersSafeFetch
) {
  const env = getEnv();
  return createGrokVideo(NATIVE_GROK_VIDEO_MODEL, apiKey, {
    fetch,
    ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
  });
}

export function createNativeGeminiVideoAdapter(apiKey: string) {
  const env = getEnv();
  return createGeminiVideo(NATIVE_GEMINI_VIDEO_MODEL, apiKey, {
    // The aimock hook for the native Google path, like XAI_BASE_URL.
    ...(env.GEMINI_BASE_URL && {
      httpOptions: { baseUrl: env.GEMINI_BASE_URL },
    }),
  });
}

/** What the `openstory` via needs from the calling step; null keeps the call direct. */
export type VideoGatewayCall = {
  scopedDb: WorkflowScopedDb;
  /** The caller's run, so the stale-job sweep can end a job whose run died. */
  runId: string;
  /** Replay-stable per submit step: a retried step finds the same job and hold. */
  idempotencyKey: string;
  /** Streams the finished clip into R2 inside the poll step that saw it (#1645). */
  store: GatewayStore;
  /** The route step's checkpointed result (`routeVideoJob`); the submit reads nothing. */
  routes: GatewayRoutes;
  /** The run's reservation: the job charges it instead of holding its own. */
  reservation: { readonly id: string } | null;
};

const GATEWAY_PROVIDER_OF_VIA: Partial<Record<MediaVia, GatewayProvider>> = {
  xai: 'grok',
  fal: 'fal',
  byteplus: 'byteplus',
};

/** The gateway provider for a video via; null where the gateway is not used (native Google). */
export function videoGatewayProvider(via: MediaVia): GatewayProvider | null {
  return GATEWAY_PROVIDER_OF_VIA[via] ?? null;
}

/** The route step's body: the own-key check through the BYOK charge-gate hatch, the stored snapshot, no body yet. */
export async function routeVideoJob(
  scopedDb: WorkflowScopedDb,
  target: GatewayRouteTarget | null
): Promise<GatewayRoutes> {
  if (!target) return {};
  return resolveGatewayRoutes(
    {
      apiKeys: {
        hasUsableKey: (provider) =>
          scopedDb.liveRead.apiKeys.hasUsableKey(provider),
      },
    },
    [target]
  );
}

/** Stores a gateway clip with the caller's upload, inside the poll that saw it (#1645). */
export function videoGatewayStore(
  upload: (
    videoUrl: string
  ) => Promise<{ url: string; path: string; contentType: string }>
): GatewayStore {
  return async (media) => {
    if (!('url' in media)) {
      throw new Error('The gateway returned an inline video');
    }
    const { url, path, contentType } = await upload(media.url);
    return { url, path, contentType };
  };
}

/** A provider call; `fetch` is passed only to capture the body it would send. */
export type VideoSend = (
  fetch?: typeof globalThis.fetch
) => Promise<{ jobId: string }>;

const jsonBody = z.record(z.string(), z.json());

/** The exact body the provider adapter would send, read off its one request; nothing leaves. */
async function captureVideoBody(send: VideoSend): Promise<GatewayJobInput> {
  let body: GatewayJobInput | undefined;
  const capture: typeof globalThis.fetch = async (input, init) => {
    body = jsonBody.parse(JSON.parse(await new Request(input, init).text()));
    throw new Error('Captured, not sent');
  };
  try {
    await send(capture);
  } catch (error) {
    if (!body) throw error;
  }
  if (!body) throw new Error('The provider call made no request');
  return body;
}

/**
 * Sends one video job. With a gateway call and a body the gateway can hold,
 * the body the provider adapter would send goes through the `openstory`
 * adapter (held, then charged by the poll that sees it finish); otherwise the
 * provider call runs as it is. The route comes from the run's route step; the body check is pure.
 */
export async function sendVideoJob(params: {
  provider: GatewayProvider;
  /** The via stamped when the job goes direct. */
  via: MediaVia;
  /** The provider's own model id: a fal endpoint, the xAI or Ark model. */
  modelId: string;
  threadId: string;
  gateway: VideoGatewayCall | null;
  /** An Ark draft or its final: task ids the gateway does not hand out (#1756). */
  draft: boolean;
  /** Whether the direct call spends the organization's own key. */
  usedOwnKey: boolean;
  send: VideoSend;
}): Promise<{ jobId: string; via: ProductVia; usedOwnKey: boolean }> {
  const gateway = params.draft ? null : params.gateway;
  if (gateway) {
    const body = await captureVideoBody(params.send);
    const route = gatewayRunRoute(
      gateway.routes,
      { provider: params.provider, modelId: params.modelId },
      body
    );
    if (route.via === 'direct') {
      logger.info('Video job routed direct', {
        provider: params.provider,
        modelId: params.modelId,
        reason: route.reason,
      });
    } else {
      const transport = inProcessGateway({
        scopedDb: gateway.scopedDb,
        model: route.model,
        runId: gateway.runId,
        store: gateway.store,
        // Uploads were gated when saved or at the click; reference clips in `check-reference-clip-rights`.
        uploadRightsChecked: UPLOAD_RIGHTS_CHECKED,
        reservation: gateway.reservation,
      });
      const job = await generateVideo({
        adapter: openstoryVideo(route.model.id, transport, {
          idempotencyKey: gateway.idempotencyKey,
        }),
        prompt: '',
        modelOptions: body,
        threadId: params.threadId,
        debug: false,
      });
      return { jobId: job.jobId, via: 'openstory', usedOwnKey: false };
    }
  }
  const job = await params.send();
  return {
    jobId: job.jobId,
    via: params.via,
    usedOwnKey: params.usedOwnKey,
  };
}

/** A run that stops polling ends its gateway job itself; a direct job has nothing held. */
export async function releaseVideoJob(
  job: Pick<StampedVideoJob, 'jobId' | 'via'>,
  scopedDb: WorkflowScopedDb,
  error: string
): Promise<void> {
  if (job.via === 'openstory') {
    await releaseInProcessJob(scopedDb, job.jobId, error);
  }
}

export type StampedVideoJob = {
  jobId: string;
  /** A missing stamp is a job from before the field: fal. */
  via: string | undefined;
  /** The provider's model id the job went to; missing on runs from before the stamp: the catalog id. */
  endpointId: string | undefined;
  modelKey: ImageToVideoModel;
  threadId?: string;
};

/**
 * One status read on the via the job was stamped with: job ids are
 * via-scoped, so a re-resolved via would read a lost generation. An
 * `openstory` job's poll that sees it finish stores and charges it.
 */
export async function pollVideoJob(
  job: StampedVideoJob,
  ctx: {
    /** Undefined runs on the platform keys (scripts with no D1). */
    credentials: CredentialScopedDb | undefined;
    /** Required to poll an `openstory` job. */
    gateway: Pick<VideoGatewayCall, 'scopedDb' | 'store'> | null;
  }
) {
  const thread = job.threadId ? { threadId: job.threadId } : {};
  const stamp = job.via ?? 'fal';
  const endpointId = job.endpointId ?? IMAGE_TO_VIDEO_MODELS[job.modelKey].id;
  if (stamp === 'openstory') {
    if (!ctx.gateway) {
      throw new Error(`Video job on the gateway polled without its store`);
    }
    return getVideoJobStatus({
      adapter: openstoryVideoStatus(endpointId, inProcessPoller(ctx.gateway)),
      jobId: job.jobId,
      ...thread,
    });
  }
  const via = assertMediaVia(stamp);
  switch (via) {
    case 'xai': {
      const key = await resolveOptionalXaiKey(ctx.credentials);
      if (!key) {
        throw new Error(
          `Video job ${job.jobId} was submitted to xAI but no xAI key is available to poll it`
        );
      }
      return getVideoJobStatus({
        adapter: createNativeGrokVideoAdapter(key.key),
        jobId: job.jobId,
        ...thread,
      });
    }
    case 'google': {
      const key = await resolveGoogleKeyForStampedJob(ctx.credentials);
      if (!key) {
        throw new Error(
          `Video job ${job.jobId} was submitted to Google but no Google key is available to poll it`
        );
      }
      const result = await getVideoJobStatus({
        adapter: createNativeGeminiVideoAdapter(key.key),
        jobId: job.jobId,
        ...thread,
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
    case 'fal': {
      const key = await resolveFalKey(ctx.credentials);
      // Bounds one status fetch; the workflow budgets the whole poll (#826).
      return getVideoJobStatus({
        adapter: falVideo(endpointId, {
          apiKey: key.key,
          fetch: createDeadlineFetch(
            FAL_REQUEST_TIMEOUT_MS,
            'Video job status'
          ),
        }),
        jobId: job.jobId,
        ...thread,
      });
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error(
          `Video job ${job.jobId} was submitted to BytePlus but no ARK_API_KEY is available to poll it`
        );
      }
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_REQUEST_TIMEOUT_MS
      );
      const createBytePlusVideo = await loadBytePlusVideo();
      return withBytePlusQuotaRetry('video poll', () =>
        getVideoJobStatus({
          adapter: createBytePlusVideo(endpointId, apiKey, config),
          jobId: job.jobId,
          ...thread,
        })
      );
    }
  }
}

/** The charge for a clip on a direct via; an `openstory` clip is charged by the gateway. */
export async function videoCostFromUsage(
  job: { via: MediaVia; endpointId: string; modelKey: ImageToVideoModel },
  usage: TokenUsage | undefined,
  source: 'motion' | 'studio-video'
) {
  const billed = billedFields(usage);
  const reportMissing = (cost: unknown) => {
    const label = `${source}-cost-from-usage-${job.via}`;
    if (cost === undefined) {
      reportMissingBillingCost({
        source: label,
        modelId: job.modelKey,
        metadata: { usage },
      });
    }
    if (billed.missingUnitsReason) {
      reportMissingBillingCost({
        source: label,
        modelId: job.modelKey,
        description: billed.missingUnitsReason,
        metadata: { usage },
      });
    }
  };
  switch (job.via) {
    case 'xai': {
      const cost = grokVideoCost(usage?.cost);
      reportMissing(cost);
      return {
        endpointId: NATIVE_GROK_VIDEO_MODEL,
        unitsBilled: billed.unitsBilled,
        billedUnit: billed.billedUnit,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'google': {
      // Omni bills seconds of video as output tokens, at Google's video rate.
      const cost = geminiVideoCostFromUsage(usage);
      reportMissing(cost);
      return {
        endpointId: NATIVE_GEMINI_VIDEO_MODEL,
        unitsBilled: billed.unitsBilled,
        billedUnit: billed.billedUnit,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'fal':
      return {
        endpointId: job.endpointId,
        unitsBilled: billed.unitsBilled,
        billedUnit: billed.billedUnit,
        cost: await falCostFromUnits(
          job.endpointId,
          billed.unitsBilled,
          undefined,
          { missingUnitsReason: billed.missingUnitsReason }
        ),
        recordFalUsage: true,
      };
    case 'byteplus': {
      const unitsBilled = bytePlusVideoUnitsBilled(usage?.totalTokens);
      return {
        endpointId: job.endpointId,
        unitsBilled,
        billedUnit: undefined,
        cost: await falCostFromUnits(job.endpointId, unitsBilled),
        recordFalUsage: false,
      };
    }
  }
}
