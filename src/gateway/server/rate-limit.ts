/** Per-organization throttle on gateway submits (`GATEWAY_RATE_LIMITER`). */

import { apiJsonError } from '@/platform/server/api-v1/errors';
import { env as workerEnv } from 'cloudflare:workers';

/** Throws a ready 429 in the `RATE_LIMITED` shape, which `runApiV1Handler` passes through. */
export async function assertGatewayRate(organizationId: string): Promise<void> {
  const { success } = await workerEnv.GATEWAY_RATE_LIMITER.limit({
    key: organizationId,
  });
  if (success) return;
  throw apiJsonError(
    429,
    'RATE_LIMITED',
    'Gateway rate limit exceeded for this organization. Retry shortly.',
    undefined,
    { 'Retry-After': '60' }
  );
}
