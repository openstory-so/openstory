/** One driver per provider: sends the caller's body as it is and reads the media and usage back. */

import { getEnv } from '#env';
import { extractFalErrorMessage } from '@/models/fal-error';
import { getArkApiKey, getArkBaseUrl } from '@/models/server/byteplus-config';
import { resolvePlatformOptionalKey } from '@/models/server/db/api-keys';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/models/server/fal-deadline-fetch';
import type { JsonValue } from '@/platform/server/db/schema';
import {
  extractAssetOutputs,
  isFalValidationError,
} from '@/studio/server/workflows/asset-generation-workflow';
import { acquireSeedSpeechToken } from '@/models/server/byteplus-governor';
import {
  getSeedSpeechApiKey,
  getSeedSpeechBaseUrl,
  isSeedSpeechConfigured,
} from '@/models/server/seed-speech-config';
import {
  BYTEPLUS_ENDPOINTS,
  type GatewayJobInput,
  type GatewayProvider,
} from '@/gateway/schema';
import type { GatewayCredentials } from '@/gateway/server/platform-credentials';
import { createFalClient } from '@fal-ai/client';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

// A synchronous image call holds the connection until the image exists.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const jsonObject = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof jsonObject>;

export type GatewayMedia =
  | { url: string; contentType: string | null }
  | { base64: string; contentType: string };

/** Never crosses a `step.do`: `base64` media would not fit the checkpoint. */
export type GatewayRunResult = {
  media: GatewayMedia[];
  usage: JsonObject | null;
  requestId: string | null;
};

export type GatewayStart = { jobId: string } | { result: GatewayRunResult };

export type GatewayPoll =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'done'; result: GatewayRunResult };

/** What a driver needs of the model; snapshotted on the run. */
export type GatewayTarget = { modelId: string; endpointId: string };

type Driver = {
  /** Whether this driver can run the endpoint on this server; asked at submit, before the hold. */
  configured: (endpointId: string) => boolean;
  start: (
    target: GatewayTarget,
    body: GatewayJobInput,
    credentials: GatewayCredentials
  ) => Promise<GatewayStart>;
  poll: (
    target: GatewayTarget,
    jobId: string,
    credentials: GatewayCredentials
  ) => Promise<GatewayPoll>;
};

/** A 4xx is the provider's answer to this body, so it is not retried; 408 and 429 are. */
async function callJson(
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
  }
): Promise<JsonObject> {
  const response = await fetch(url, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = `Provider refused the request (${response.status}): ${text.slice(0, 500)}`;
    const final =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429;
    throw final ? new NonRetryableError(message) : new Error(message);
  }
  return jsonObject.parse(JSON.parse(text));
}

/** E2E stays on the mocks: a laptop key must not bill a replay. */
function nativeOn(baseUrl: string | undefined): boolean {
  return getEnv().E2E_TEST !== 'true' || Boolean(baseUrl);
}

function requireNative(baseUrl: string | undefined, name: string): void {
  if (!nativeOn(baseUrl)) {
    throw new NonRetryableError(`${name} is off under E2E_TEST`);
  }
}

function recordOrNull(value: unknown): JsonObject | null {
  const parsed = jsonObject.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** OpenAI-shaped image answers (`data[].url` or `data[].b64_json`): xAI and Ark. */
function imagesFromData(body: JsonObject): GatewayMedia[] {
  const data = Array.isArray(body.data) ? body.data : [];
  return data.flatMap((item): GatewayMedia[] => {
    const entry = recordOrNull(item);
    if (typeof entry?.url === 'string') {
      return [{ url: entry.url, contentType: null }];
    }
    if (typeof entry?.b64_json === 'string') {
      return [{ base64: entry.b64_json, contentType: 'image/png' }];
    }
    return [];
  });
}

const falDriver: Driver = {
  configured: () => resolvePlatformOptionalKey('fal') !== undefined,
  start: async (target, body, credentials) => {
    const fal = await falClient(credentials);
    try {
      const { request_id } = await fal.queue.submit(target.modelId, {
        input: body,
      });
      return { jobId: request_id };
    } catch (error) {
      if (isFalValidationError(error)) {
        throw new NonRetryableError(
          `Provider refused the request (422): ${extractFalErrorMessage(error)}`
        );
      }
      throw error;
    }
  },
  poll: async (target, jobId, credentials) => {
    const fal = await falClient(credentials);
    const status = await fal.queue.status(target.modelId, {
      requestId: jobId,
      logs: false,
    });
    if (status.status !== 'COMPLETED') return { status: 'pending' };
    let data: JsonValue;
    try {
      data = (await fal.queue.result(target.modelId, { requestId: jobId }))
        .data;
    } catch (error) {
      // A failed fal job rejects here with the provider's reason.
      return { status: 'failed', error: extractFalErrorMessage(error) };
    }
    return {
      status: 'done',
      result: {
        media: extractAssetOutputs(data),
        usage: falUsage(data),
        requestId: jobId,
      },
    };
  },
};

const falImages = z.object({
  images: z.array(z.object({ width: z.number(), height: z.number() })).min(1),
});

/** fal's result carries no usage: per-megapixel cards read the result's own image sizes. */
function falUsage(data: JsonValue): JsonObject | null {
  const parsed = falImages.safeParse(data);
  if (!parsed.success) return null;
  const pixels = parsed.data.images.reduce(
    (sum, image) => sum + image.width * image.height,
    0
  );
  return { megapixels: pixels / 1_000_000 };
}

/** A client per call: a shared `fal.config` would let concurrent calls send each other's key. */
async function falClient(credentials: GatewayCredentials) {
  const { key } = await credentials.resolveKey('fal');
  return createFalClient({
    credentials: key,
    fetch: createDeadlineFetch(FAL_REQUEST_TIMEOUT_MS, 'Gateway request'),
  });
}

async function grokCall(
  credentials: GatewayCredentials,
  path: string,
  body?: GatewayJobInput
): Promise<JsonObject> {
  const override = getEnv().XAI_BASE_URL;
  requireNative(override, 'xAI');
  const { key } = await credentials.resolveKey('xai');
  return callJson(`${override ?? 'https://api.x.ai/v1'}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}` },
    body,
  });
}

const grokDriver: Driver = {
  configured: () =>
    nativeOn(getEnv().XAI_BASE_URL) &&
    resolvePlatformOptionalKey('xai') !== undefined,
  start: async (target, body, credentials) => {
    // modelschemas names the endpoint with its version: `v1/videos/generations`.
    const answer = await grokCall(
      credentials,
      target.endpointId.replace(/^v1\//, ''),
      body
    );
    const requestId = text(answer.request_id);
    if (requestId) return { jobId: requestId };
    return {
      result: {
        media: imagesFromData(answer),
        usage: recordOrNull(answer.usage),
        requestId: null,
      },
    };
  },
  poll: async (_target, jobId, credentials) => {
    const answer = await grokCall(credentials, `videos/${jobId}`);
    const status = text(answer.status);
    const url = text(recordOrNull(answer.video)?.url);
    if (status === 'done' || status === 'completed' || status === 'succeeded') {
      return {
        status: 'done',
        result: {
          media: url ? [{ url, contentType: 'video/mp4' }] : [],
          usage: recordOrNull(answer.usage),
          requestId: jobId,
        },
      };
    }
    if (
      status === 'failed' ||
      status === 'expired' ||
      status === 'error' ||
      status === 'cancelled'
    ) {
      return { status: 'failed', error: text(answer.error) ?? `Job ${status}` };
    }
    return { status: 'pending' };
  },
};

async function arkCall(
  path: string,
  body?: GatewayJobInput
): Promise<JsonObject> {
  const override = getArkBaseUrl();
  requireNative(override, 'BytePlus');
  const key = getArkApiKey();
  if (!key) throw new NonRetryableError('No platform key for BytePlus');
  return callJson(
    `${override ?? 'https://ark.ap-southeast.bytepluses.com/api/v3'}/${path}`,
    {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key}` },
      body,
    }
  );
}

const ARK_TASKS = BYTEPLUS_ENDPOINTS.tasks;

const SEED_AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg_opus: 'audio/ogg',
};

/** Seed Audio is not on Ark: its own host, key and account-wide pacing. */
async function seedSpeech(body: GatewayJobInput): Promise<GatewayStart> {
  // Also off under E2E_TEST with no base URL override.
  if (!isSeedSpeechConfigured()) {
    throw new NonRetryableError('No platform key for Seed Speech');
  }
  const format = text(recordOrNull(body.audio_config)?.format) ?? 'wav';
  const contentType = SEED_AUDIO_TYPES[format];
  if (!contentType) {
    throw new NonRetryableError(`Seed Audio format ${format} is not stored`);
  }
  await acquireSeedSpeechToken();
  const answer = await callJson(
    `${getSeedSpeechBaseUrl()}/api/v3/${BYTEPLUS_ENDPOINTS.speech}`,
    {
      method: 'POST',
      headers: { 'x-api-key': getSeedSpeechApiKey() ?? '' },
      body,
    }
  );
  const audio = text(answer.audio);
  // Billed on the seconds before `speech_rate`, which only the answer carries.
  const billed = answer.original_duration;
  if (typeof billed !== 'number') {
    throw new Error('Seed Audio returned no original_duration');
  }
  return {
    result: {
      media: audio ? [{ base64: audio, contentType }] : [],
      usage: { original_duration: billed },
      requestId: null,
    },
  };
}

const bytePlusDriver: Driver = {
  // Seed Audio is not on Ark: its own key.
  configured: (endpointId) =>
    endpointId === BYTEPLUS_ENDPOINTS.speech
      ? isSeedSpeechConfigured()
      : nativeOn(getArkBaseUrl()) && Boolean(getArkApiKey()),
  start: async (target, body) => {
    if (target.endpointId === BYTEPLUS_ENDPOINTS.speech) {
      return seedSpeech(body);
    }
    const answer = await arkCall(target.endpointId, body);
    if (target.endpointId === ARK_TASKS) {
      const id = text(answer.id);
      if (!id) throw new Error('BytePlus returned no task id');
      return { jobId: id };
    }
    return {
      result: {
        media: imagesFromData(answer),
        usage: recordOrNull(answer.usage),
        requestId: null,
      },
    };
  },
  poll: async (_target, jobId) => {
    const task = await arkCall(`${ARK_TASKS}/${jobId}`);
    const status = text(task.status);
    if (status === 'succeeded') {
      const url = text(recordOrNull(task.content)?.video_url);
      return {
        status: 'done',
        result: {
          media: url ? [{ url, contentType: 'video/mp4' }] : [],
          usage: recordOrNull(task.usage),
          requestId: jobId,
        },
      };
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const error = recordOrNull(task.error);
      return {
        status: 'failed',
        error:
          [text(error?.code), text(error?.message)]
            .filter(Boolean)
            .join(': ') || `Task ${status}`,
      };
    }
    return { status: 'pending' };
  },
};

const geminiAnswer = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  inlineData: z
                    .object({ mimeType: z.string(), data: z.string() })
                    .optional(),
                })
              )
              .default([]),
          })
          .optional(),
        finishReason: z.string().optional(),
      })
    )
    .default([]),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: jsonObject.optional(),
  responseId: z.string().optional(),
});

const geminiDriver: Driver = {
  configured: () =>
    nativeOn(getEnv().GEMINI_BASE_URL) &&
    resolvePlatformOptionalKey('google') !== undefined,
  start: async (target, body, credentials) => {
    const override = getEnv().GEMINI_BASE_URL;
    requireNative(override, 'Google');
    const { key } = await credentials.resolveKey('google');
    // modelschemas: `v1beta/models/{modelsId}:generateContent`.
    const path = target.endpointId.replace('{modelsId}', target.modelId);
    const answer = geminiAnswer.parse(
      await callJson(
        `${override ?? 'https://generativelanguage.googleapis.com'}/${path}`,
        { method: 'POST', headers: { 'x-goog-api-key': key }, body }
      )
    );
    const media = answer.candidates.flatMap((candidate) =>
      (candidate.content?.parts ?? []).flatMap((part): GatewayMedia[] =>
        part.inlineData
          ? [
              {
                base64: part.inlineData.data,
                contentType: part.inlineData.mimeType,
              },
            ]
          : []
      )
    );
    if (media.length === 0) {
      const reason =
        answer.promptFeedback?.blockReason ??
        answer.candidates[0]?.finishReason ??
        'no media';
      throw new NonRetryableError(`Google returned no media: ${reason}`);
    }
    return {
      result: {
        media,
        usage: answer.usageMetadata ?? null,
        requestId: answer.responseId ?? null,
      },
    };
  },
  poll: async () => {
    throw new NonRetryableError('Google jobs answer at once');
  },
};

export const GATEWAY_DRIVERS: Readonly<Record<GatewayProvider, Driver>> = {
  fal: falDriver,
  grok: grokDriver,
  byteplus: bytePlusDriver,
  gemini: geminiDriver,
};
