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
import { getLogger } from '@/platform/logger';
import type { AcquireInput, BytePlusGovernor } from './byteplus-governor.do';

const logger = getLogger(['openstory', 'ai', 'byteplus-governor']);

/**
 * Two buckets. `CreateAsset` is paced by `BYTEPLUS_ASSET_WRITE_QPM`, which
 * is why only stills that can carry a face are ingested at all (character
 * sheets and start frames; see `submitMotionJob`). Reads (`ListAssets`,
 * `GetAsset` polls, group lookup) sit under `BYTEPLUS_OPENAPI_QPM`.
 */
const DEFAULT_ASSET_WRITE_QPM = 3;
const DEFAULT_OPENAPI_QPM = 60;
const WRITE_ACTIONS = new Set(['CreateAsset']);
const GOVERNOR_NAME = 'byteplus';

/**
 * Longest a create waits for its turn. The wait is a durable `step.sleep`
 * (`byteplus-asset-steps.ts`), so this bounds the queue, not a Worker.
 * Beyond it the DO refuses without reserving and the shot fails with a
 * message that names the queue.
 */
const CREATE_MAX_WAIT_MS = 15 * 60_000;

/**
 * Reads are paced in-step: their waits are seconds, and a Worker sleeping a
 * few seconds is cheaper than a step boundary.
 */
const READ_MAX_WAIT_MS = 60_000;

function envQpm(name: string, fallback: number): number {
  const raw = Reflect.get(getEnv(), name);
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeBucket(): AcquireInput {
  const qpm = envQpm('BYTEPLUS_ASSET_WRITE_QPM', DEFAULT_ASSET_WRITE_QPM);
  return {
    bucket: 'assets-write',
    // One at a time, not a burst of `qpm`: Ark 429s a same-second burst
    // even when the minute budget is free (#1674).
    capacity: 1,
    refillPerMinute: qpm,
    maxWaitMs: CREATE_MAX_WAIT_MS,
  };
}

function readBucket(): AcquireInput {
  const qpm = envQpm('BYTEPLUS_OPENAPI_QPM', DEFAULT_OPENAPI_QPM);
  return {
    bucket: 'assets-read',
    capacity: Math.min(10, qpm),
    refillPerMinute: qpm,
    maxWaitMs: READ_MAX_WAIT_MS,
  };
}

function refused(action: string, bucket: AcquireInput): Error {
  return new Error(
    `BytePlus ${action} queue is longer than ${bucket.maxWaitMs / 60_000} minutes (this deployment allows ${bucket.refillPerMinute}/min). Retry once the batch ahead has cleared.`
  );
}

/**
 * Reserve a CreateAsset turn. Returns the ms to `step.sleep` before
 * creating — 0 when the token is free now. Call it from its own `step.do`
 * so a replay reuses the reservation instead of taking another.
 */
export async function reserveBytePlusCreateSlot(): Promise<number> {
  const stub = governorStub();
  if (!stub) return 0;
  const bucket = writeBucket();
  const delayMs = await stub.acquire(bucket);
  if (delayMs < 0) throw refused('CreateAsset', bucket);
  return delayMs;
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
 * Pace a call before it fires. A CreateAsset's first attempt is not paced
 * here: its token was reserved by {@link reserveBytePlusCreateSlot} and slept
 * off durably, so a second reservation would spend a turn nobody uses. Its
 * quota RETRIES are another create, so they take a turn like anyone else —
 * waited in-step, bounded like a read — rather than cutting in ahead of the
 * runs asleep on theirs (#1674). No-op where the DO is not bound (unit
 * tests, scripts) — the backoff retry still covers those.
 */
export async function acquireBytePlusOpenApiToken(
  action: string,
  retry: boolean
): Promise<void> {
  const write = WRITE_ACTIONS.has(action);
  if (write && !retry) return;
  const stub = governorStub();
  if (!stub) return;
  const bucket = write
    ? { ...writeBucket(), maxWaitMs: READ_MAX_WAIT_MS }
    : readBucket();
  const delayMs = await stub.acquire(bucket);
  if (delayMs < 0) throw refused(action, bucket);
  if (delayMs === 0) return;
  logger.debug(`BytePlus ${action}: governor delay ${delayMs}ms`, {
    action,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Seed Speech (#1765) caps queries per second per ACCOUNT: eight parallel
 * Seed Audio calls got `429 quota exceeded for types: qps`. Its own bucket on
 * the same governor, paced in-step like a read. `SEED_SPEECH_QPM` overrides.
 */
const DEFAULT_SEED_SPEECH_QPM = 30;
const SEED_SPEECH_MAX_WAIT_MS = 5 * 60_000;

export async function acquireSeedSpeechToken(): Promise<void> {
  const stub = governorStub();
  if (!stub) return;
  const qpm = envQpm('SEED_SPEECH_QPM', DEFAULT_SEED_SPEECH_QPM);
  const bucket: AcquireInput = {
    bucket: 'seed-speech',
    capacity: 2,
    refillPerMinute: qpm,
    maxWaitMs: SEED_SPEECH_MAX_WAIT_MS,
  };
  const delayMs = await stub.acquire(bucket);
  if (delayMs < 0) throw refused('Seed Audio', bucket);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}
