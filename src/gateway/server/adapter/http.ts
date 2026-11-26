/**
 * The HTTP transport: a self-hosted install's calls on the hosted gateway,
 * paid by its `OPENSTORY_API_KEY` organization (docs/architecture/model-gateway.md
 * § Self-hosted on one key). No local hold, no local debit.
 */

import { getEnv } from '#env';
import type {
  GatewayJobInput,
  GatewayJobOutput,
  GatewayProvider,
} from '@/gateway/schema';
import type { GatewayPoller, GatewayTransport } from '@/gateway/server/adapter';
import {
  inProcessGateway,
  inProcessPoller,
} from '@/gateway/server/adapter/in-process';
import {
  gatewayJobResourceSchema,
  type GatewayJobResource,
} from '@/gateway/server/api-documents';
import type { GatewayStore } from '@/gateway/server/phases';
import {
  DEFAULT_GATEWAY_URL,
  remoteHandle,
  remoteJobOf,
} from '@/gateway/server/remote-config';
import type { GatewayCallRoute } from '@/gateway/server/route';
import type { JsonValue } from '@/platform/server/db/schema';
import { r2KeyFromUrl } from '@/platform/server/storage/buckets';
import { sha256Hex } from '@/platform/compliance/hash';
import { getLogger } from '@/platform/logger';
import { readStorageObject } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

const logger = getLogger(['openstory', 'gateway', 'http']);

const POLL_WAIT = '20s';

/** Read inside the call that spends it: never on a payload, a URL or a log. */
function remoteGateway(): { base: string; key: string } {
  const env = getEnv();
  if (!env.OPENSTORY_API_KEY) {
    throw new NonRetryableError('OPENSTORY_API_KEY is not set on this install');
  }
  return {
    base: (env.OPENSTORY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/$/, ''),
    key: env.OPENSTORY_API_KEY,
  };
}

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** One call to the hosted gateway. A refusal (a 4xx other than 429) is final and reads as the hosted side wrote it. */
async function callGateway(
  path: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Readonly<Record<string, string>>;
    body?: BodyInit;
  }
): Promise<unknown> {
  const { base, key } = remoteGateway();
  const response = await fetch(`${base}/api/v1/gateway/${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (response.ok) return JSON.parse(text);
  const parsed = errorEnvelope.safeParse(safeJson(text));
  const reason = parsed.success
    ? `${parsed.data.error.code}: ${parsed.data.error.message}`
    : `HTTP ${response.status}`;
  const message = `The hosted gateway refused this call (${reason})`;
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
  ) {
    throw new NonRetryableError(message);
  }
  throw new Error(message);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const uploadAnswer = z.object({ url: z.string() });

/**
 * Every local `/r2/` file in the body goes up to the hosted gateway first
 * (`POST /gateway/uploads`); the key names the file, so a retried step gets
 * the same URL back and the job's Idempotency-Key sees the same body.
 */
async function withUploadedMedia(
  body: GatewayJobInput,
  idempotencyKey: string
): Promise<GatewayJobInput> {
  const uploaded = new Map<string, Promise<string>>();
  const upload = (url: string, key: string) => {
    let pending = uploaded.get(url);
    if (!pending) {
      pending = uploadStored(key, `${idempotencyKey}:${key}`);
      uploaded.set(url, pending);
    }
    return pending;
  };
  const walk = async (value: JsonValue): Promise<JsonValue> => {
    if (typeof value === 'string') {
      const key = value.startsWith('/r2/') ? r2KeyFromUrl(value) : null;
      return key === null ? value : upload(value, key);
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value !== null && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(
          async ([field, item]) => [field, await walk(item)] as const
        )
      );
      return Object.fromEntries(entries);
    }
    return value;
  };
  const walked = await walk(body);
  return z.record(z.string(), z.json()).parse(walked);
}

// ponytail: reads the whole file into the isolate; stream it when reference clips grow past a few MB.
async function uploadStored(key: string, uploadKey: string): Promise<string> {
  const object = await readStorageObject(key);
  if (!object) throw new NonRetryableError(`No stored file at ${key}`);
  const filename = key.split('/').pop() ?? 'upload';
  const answer = await callGateway(
    `uploads?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: {
        'content-type': object.contentType || 'application/octet-stream',
        'idempotency-key': await sha256Hex(uploadKey),
      },
      body: object.bytes,
    }
  );
  return uploadAnswer.parse(answer).url;
}

/** Copies a finished hosted job's outputs into this install's storage, as a provider's CDN URL is. */
async function storeRemoteOutputs(
  job: GatewayJobResource,
  store: GatewayStore
): Promise<GatewayJobOutput[]> {
  if (job.outputs.length === 0) {
    throw new NonRetryableError(
      `Hosted gateway job ${job.id} succeeded with no outputs`
    );
  }
  logger.info('Hosted gateway job finished', {
    jobId: job.id,
    chargeMicros: job.charge?.totalMicros ?? null,
  });
  return Promise.all(
    job.outputs.map((output, index) =>
      store({ url: output.url, contentType: output.contentType }, index)
    )
  );
}

function failure(job: GatewayJobResource): string {
  return job.error
    ? `${job.error.code}: ${job.error.message}`
    : 'Generation failed';
}

async function readRemoteJob(jobId: string, wait: string | null) {
  const query = wait ? `?wait=${wait}` : '';
  return gatewayJobResourceSchema.parse(
    await callGateway(`jobs/${encodeURIComponent(jobId)}${query}`, {
      method: 'GET',
    })
  );
}

/** Polls a remote handle; the poll that sees the job finish copies its outputs here. A retried poll copies again; the charge is the hosted job's, once. */
function httpPoller(store: GatewayStore): GatewayPoller {
  return {
    poll: async (handle) => {
      const jobId = remoteJobOf(handle);
      if (!jobId) throw new Error(`Not a hosted gateway handle: ${handle}`);
      const job = await readRemoteJob(jobId, POLL_WAIT);
      if (job.status === 'succeeded') {
        return { kind: 'done', outputs: await storeRemoteOutputs(job, store) };
      }
      if (job.status === 'failed')
        return { kind: 'failed', error: failure(job) };
      return { kind: 'pending' };
    },
  };
}

/** Submits to `POST /gateway/{provider}/{model}` under the call's Idempotency-Key. */
function httpGateway(params: {
  provider: GatewayProvider;
  modelId: string;
  store: GatewayStore;
}): GatewayTransport {
  return {
    ...httpPoller(params.store),
    submit: async (body, idempotencyKey) => {
      const job = gatewayJobResourceSchema.parse(
        await callGateway(`${params.provider}/${params.modelId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(await withUploadedMedia(body, idempotencyKey)),
        })
      );
      if (job.status === 'succeeded') {
        return {
          kind: 'done',
          jobId: remoteHandle(job.id),
          outputs: await storeRemoteOutputs(job, params.store),
        };
      }
      if (job.status === 'failed') throw new NonRetryableError(failure(job));
      return { kind: 'queued', handle: remoteHandle(job.id) };
    },
  };
}

/** The hosted charge of a remote job, for display only; this install debits nothing. */
export async function remoteJobCharge(jobId: string): Promise<number | null> {
  return (await readRemoteJob(jobId, null)).charge?.totalMicros ?? null;
}

type InProcessParams = Omit<Parameters<typeof inProcessGateway>[0], 'model'>;

/** The transport for a gateway route: in-process on this server's keys, HTTP on the install's OpenStory key. */
export function gatewayTransport(
  route: GatewayCallRoute,
  params: InProcessParams
): { modelId: string; transport: GatewayTransport } {
  if (route.via === 'remote') {
    return {
      modelId: route.target.modelId,
      transport: httpGateway({ ...route.target, store: params.store }),
    };
  }
  return {
    modelId: route.model.id,
    transport: inProcessGateway({ ...params, model: route.model }),
  };
}

/** The poller for a handle either transport gave out. */
export function gatewayPoller(
  handle: string,
  params: Parameters<typeof inProcessPoller>[0]
): GatewayPoller {
  return remoteJobOf(handle)
    ? httpPoller(params.store)
    : inProcessPoller(params);
}
