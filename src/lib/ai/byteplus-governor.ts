/**
 * Client side of the BytePlus governor DO (#1519): take a token, sleep for
 * whatever the bucket says, then send. See `byteplus-governor.do.ts`.
 *
 * Rate is per Worker deployment: previews and production each own a DO
 * namespace, so two deployments on the same BytePlus account still add up
 * (the same caveat as the ACR slot pool). Set `BYTEPLUS_OPENAPI_QPM` below
 * the account's real quota divided by the deployments sharing it.
 */

import { getEnv } from '#env';
import { getLogger } from '@/lib/observability/logger';
import type { BytePlusGovernor } from './byteplus-governor.do';

const logger = getLogger(['openstory', 'ai', 'byteplus-governor']);

/**
 * Two buckets. `CreateAsset` is the scarce one — the account allows THREE
 * per minute (`QuotaWriteQPMExceeded`, relayed by Tom 2026-09-07), which is
 * why only stills that can carry a face are ingested at all (character
 * sheets and start frames; see `submitMotionJob`). Reads (`ListAssets`,
 * `GetAsset` polls, group lookup) sit under a separate flow-control limit
 * BytePlus does not publish; 60/min has not tripped it.
 */
const DEFAULT_ASSET_WRITE_QPM = 3;
const DEFAULT_OPENAPI_QPM = 60;
const WRITE_ACTIONS = new Set(['CreateAsset']);
const GOVERNOR_NAME = 'byteplus';

/**
 * Longest a caller sleeps for a token. The Cloudflare step this runs inside
 * defaults to a 10-minute limit; beyond this the DO refuses without
 * reserving and the shot fails with a message that names the queue.
 */
const BYTEPLUS_GOVERNOR_MAX_WAIT_MS = 5 * 60_000;

function envQpm(name: string, fallback: number): number {
  const raw = Reflect.get(getEnv(), name);
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bucketFor(action: string): {
  bucket: string;
  capacity: number;
  refillPerMinute: number;
} {
  if (WRITE_ACTIONS.has(action)) {
    const qpm = envQpm('BYTEPLUS_ASSET_WRITE_QPM', DEFAULT_ASSET_WRITE_QPM);
    return { bucket: 'assets-write', capacity: qpm, refillPerMinute: qpm };
  }
  const qpm = envQpm('BYTEPLUS_OPENAPI_QPM', DEFAULT_OPENAPI_QPM);
  return {
    bucket: 'assets-read',
    capacity: Math.min(10, qpm),
    refillPerMinute: qpm,
  };
}

function governorStub(): DurableObjectStub<BytePlusGovernor> | undefined {
  // getEnv()'s type is platform-dependent; the Cloudflare runtime guarantees
  // the Cloudflare.Env shape, and outside it (tests, scripts) the binding is
  // simply absent.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- platform-dependent env shape
  const namespace = (getEnv() as unknown as Partial<Cloudflare.Env>)
    .BYTEPLUS_GOVERNOR;
  if (!namespace) return undefined;
  return namespace.get(namespace.idFromName(GOVERNOR_NAME));
}

/**
 * Wait for a token before an Assets OpenAPI call. No-op where the DO is not
 * bound (unit tests, scripts) — the backoff retry still covers those.
 */
export async function acquireBytePlusOpenApiToken(
  action: string
): Promise<void> {
  const stub = governorStub();
  if (!stub) return;
  const delayMs = await stub.acquire({
    ...bucketFor(action),
    maxWaitMs: BYTEPLUS_GOVERNOR_MAX_WAIT_MS,
  });
  if (delayMs < 0) {
    throw new Error(
      `BytePlus ${action} queue is longer than ${BYTEPLUS_GOVERNOR_MAX_WAIT_MS / 60_000} minutes (the account allows ${bucketFor(action).refillPerMinute}/min). Retry once the batch ahead has cleared.`
    );
  }
  if (delayMs === 0) return;
  logger.debug(`BytePlus ${action}: governor delay ${delayMs}ms`, {
    action,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
