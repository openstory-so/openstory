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
 * Sustained Assets OpenAPI calls per minute. BytePlus publishes no number;
 * `QuotaWriteQPMExceeded` landed on a ~15-call burst in #1519, so this
 * starts conservative. Raise it via `BYTEPLUS_OPENAPI_QPM` once a live
 * account shows headroom.
 */
const DEFAULT_OPENAPI_QPM = 60;
const OPENAPI_BURST = 10;
const BUCKET = 'assets-openapi';
const GOVERNOR_NAME = 'byteplus';

function openApiQpm(): number {
  const raw = Reflect.get(getEnv(), 'BYTEPLUS_OPENAPI_QPM');
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENAPI_QPM;
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
    bucket: BUCKET,
    capacity: OPENAPI_BURST,
    refillPerMinute: openApiQpm(),
  });
  if (delayMs <= 0) return;
  logger.debug(`BytePlus ${action}: governor delay ${delayMs}ms`, {
    action,
    delayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
