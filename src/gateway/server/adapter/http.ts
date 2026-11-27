/**
 * The HTTP transport: a self-hosted install's calls on the hosted gateway,
 * paid by its `OPENSTORY_API_KEY` organization (docs/architecture/model-gateway.md
 * § Self-hosted on one key). No local hold, no local debit.
 */

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
  hostedFetch,
  hostedModelPath,
  remoteHandle,
  remoteJobOf,
} from '@/gateway/server/remote-config';
import type { GatewayCallRoute } from '@/gateway/server/route';
import type { JsonValue } from '@/platform/server/db/schema';
import { stableMediaUrl } from '@/platform/server/storage/external-url';
import {
  buildR2Key,
  fromShareableUrl,
  r2KeyFromUrl,
  STORAGE_BUCKETS,
  storedUrlOwnedBy,
} from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import { sha256Hex } from '@/platform/compliance/hash';
import { getLogger } from '@/platform/logger';
import { readStorageObject, uploadFile } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import { jsonObjectSchema } from '@/gateway/schema';
import { z } from 'zod';

const logger = getLogger(['openstory', 'gateway', 'http']);

const POLL_WAIT = '20s';

async function callGateway(
  path: string,
  init: Parameters<typeof hostedFetch>[1]
): Promise<unknown> {
  return (await hostedFetch(path, init)).json();
}

const uploadAnswer = z.object({ url: z.string() });

const PROVENANCE = STORAGE_BUCKETS.GATEWAY_PROVENANCE;

/** The R2 key of a file this install stores, in each form a body carries it (`/r2/…`, its stable app or CDN URL), whoever owns it; null for any other host. */
function localStorageKey(url: string): string | null {
  const key = r2KeyFromUrl(fromShareableUrl(url));
  if (key === null) return null;
  const stored = `/r2/${key}`;
  return url === stored || url === stableMediaUrl(stored, null) ? key : null;
}

/** The hosted output URL a local object was copied from, or null when the file was not made by the hosted gateway. */
async function hostedSourceOf(key: string): Promise<string | null> {
  const stored = await readStorageObject(
    buildR2Key(PROVENANCE, await sha256Hex(key))
  );
  return stored ? new TextDecoder().decode(stored.bytes) : null;
}

/**
 * Every local `/r2/` file in the body goes to the hosted gateway first. One
 * the hosted gateway made goes back as its hosted URL, which the hosted side
 * verifies against its own job; any other is uploaded (`POST /gateway/uploads`)
 * and classified there. The key names the file, so a retried step gets the
 * same URL back and the job's Idempotency-Key sees the same body.
 */
async function withUploadedMedia(
  body: GatewayJobInput,
  idempotencyKey: string,
  organizationId: string
): Promise<GatewayJobInput> {
  const uploaded = new Map<string, Promise<string>>();
  const upload = (url: string, key: string) => {
    let pending = uploaded.get(url);
    if (!pending) {
      pending = hostedSourceOf(key).then((hosted) => {
        if (hosted) return hosted;
        if (
          getMimeTypeFromExtension(getExtensionFromUrl(url)).startsWith(
            'audio/'
          )
        ) {
          throw new NonRetryableError(
            'Audio recorded or made on this install cannot be sent to the hosted gateway; only audio the hosted gateway generated can'
          );
        }
        return uploadStored(key, `${idempotencyKey}:${key}`);
      });
      uploaded.set(url, pending);
    }
    return pending;
  };
  const walk = async (value: JsonValue): Promise<JsonValue> => {
    if (typeof value === 'string') {
      const key = localStorageKey(value);
      if (key === null) return value;
      // Only the run's own files leave this install; checked before anything is read.
      if (!storedUrlOwnedBy(`/r2/${key}`, organizationId)) {
        throw new NonRetryableError(
          'An input file belongs to another organization'
        );
      }
      return upload(value, key);
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
  return jsonObjectSchema.parse(walked);
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
    job.outputs.map(async (output, index) => {
      const stored = await store(
        { url: output.url, contentType: output.contentType },
        index
      );
      // So a later call can send the hosted URL back instead of uploading these bytes.
      const key = r2KeyFromUrl(stored.url);
      if (key !== null) {
        await uploadFile(
          PROVENANCE,
          await sha256Hex(key),
          new TextEncoder().encode(output.url),
          { contentType: 'text/plain' }
        );
      }
      return stored;
    })
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
  organizationId: string;
  store: GatewayStore;
}): GatewayTransport {
  return {
    ...httpPoller(params.store),
    submit: async (body, idempotencyKey) => {
      const job = gatewayJobResourceSchema.parse(
        await callGateway(hostedModelPath(params.provider, params.modelId), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(
            await withUploadedMedia(body, idempotencyKey, params.organizationId)
          ),
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
      transport: httpGateway({
        ...route.target,
        organizationId: params.scopedDb.organizationId,
        store: params.store,
      }),
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
