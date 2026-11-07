/**
 * Client side of the ElevenLabs governor DO (#2295): take a slot, call, give
 * the slot back. See `elevenlabs-governor.do.ts`.
 *
 * Slots are per Worker deployment: previews and production each own a DO
 * namespace, so two deployments on the same ElevenLabs account still add up.
 */

import { getEnv } from '#env';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import { getPostHogClient } from '@/platform/server/observability/posthog-server';
import type { ElevenLabsGovernor } from './elevenlabs-governor.do';

const logger = getLogger(['openstory', 'ai', 'elevenlabs-governor']);

/** The plan's concurrent-request limit. */
const ELEVENLABS_CONCURRENCY = 2;
/** Longer than one call with the SDK's own retries. */
const LEASE_MS = 10 * 60_000;
/** Then the step fails and its retry backoff takes over. */
const MAX_WAIT_MS = 5 * 60_000;
const POLL_MS = 2_000;
const GOVERNOR_NAME = 'elevenlabs';

const BACKOFF_EVENT = 'elevenlabs_concurrency_backoff';

export type ElevenLabsCall = {
  /** Which call — e.g. `voice design`, `voice save`. */
  operation: string;
  /** The workflow step's attempt. */
  attempt: number;
  /** True when the step has no retry left. */
  lastAttempt: boolean;
};

function governorStub(): DurableObjectStub<ElevenLabsGovernor> | undefined {
  // Outside workerd (tests, scripts) the binding is absent.
  const env: Partial<Cloudflare.Env> = getEnv();
  const namespace = env.ELEVENLABS_GOVERNOR;
  if (!namespace) return undefined;
  return namespace.get(namespace.idFromName(GOVERNOR_NAME));
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}

/**
 * One event per collision, un-deduped like `byteplus_quota_backoff`:
 * `queued` — the call waited for a slot; `rejected` — ElevenLabs answered 429.
 */
function reportBackoff(
  call: ElevenLabsCall,
  outcome: { cause: 'queued'; waitMs: number } | { cause: 'rejected' }
): void {
  getPostHogClient()?.capture({
    distinctId: 'system',
    event: BACKOFF_EVENT,
    properties: {
      operation: call.operation,
      attempt: call.attempt,
      cause: outcome.cause,
      ...(outcome.cause === 'queued'
        ? { wait_ms: outcome.waitMs }
        : { exhausted: call.lastAttempt }),
    },
  });
}

async function takeSlot(
  stub: DurableObjectStub<ElevenLabsGovernor>,
  holder: string,
  call: ElevenLabsCall
): Promise<void> {
  const startedAt = Date.now();
  let waited = false;
  const slot = { holder, slots: ELEVENLABS_CONCURRENCY, leaseMs: LEASE_MS };
  while (!(await stub.acquire(slot))) {
    if (Date.now() - startedAt >= MAX_WAIT_MS) {
      throw new Error(
        `ElevenLabs ${call.operation}: no free request slot after ${MAX_WAIT_MS / 60_000} minutes (the plan allows ${ELEVENLABS_CONCURRENCY} at once).`
      );
    }
    waited = true;
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_MS * (1 + Math.random() / 2))
    );
  }
  if (waited) {
    reportBackoff(call, { cause: 'queued', waitMs: Date.now() - startedAt });
  }
}

/**
 * Run one ElevenLabs request inside an account slot. A 429 is reported and
 * rethrown so the step's backoff retries it. No-op where the DO is not bound.
 */
export async function withElevenLabsSlot<T>(
  call: ElevenLabsCall,
  fn: () => Promise<T>
): Promise<T> {
  const stub = governorStub();
  const holder = generateId();
  if (stub) await takeSlot(stub, holder, call);
  try {
    return await fn();
  } catch (error) {
    if (statusOf(error) === 429) reportBackoff(call, { cause: 'rejected' });
    throw error;
  } finally {
    if (stub) {
      await stub.release(holder).catch((err: unknown) => {
        logger.warn(`ElevenLabs ${call.operation}: slot release failed`, {
          err,
        });
      });
    }
  }
}
