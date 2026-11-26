/** Per-organization throttles: gateway calls (`GATEWAY_RATE_LIMITER`) and uploads (`GATEWAY_UPLOAD_RATE_LIMITER`). */

import { apiJsonError } from '@/platform/server/api-v1/errors';
import { env as workerEnv } from 'cloudflare:workers';

/** Throws a ready 429 in the `RATE_LIMITED` shape, which `runApiV1Handler` passes through. */
export async function assertGatewayRate(
  organizationId: string,
  bucket: 'calls' | 'uploads'
): Promise<void> {
  const limiter =
    bucket === 'uploads'
      ? workerEnv.GATEWAY_UPLOAD_RATE_LIMITER
      : workerEnv.GATEWAY_RATE_LIMITER;
  const { success } = await limiter.limit({ key: organizationId });
  if (success) return;
  throw apiJsonError(
    429,
    'RATE_LIMITED',
    'Gateway rate limit exceeded for this organization. Retry shortly.',
    undefined,
    { 'Retry-After': '60' }
  );
}
