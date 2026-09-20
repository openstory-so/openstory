import { assertDeviceLoginRate } from '@/platform/server/api-v1/device-auth';
import { getAuth } from '@/platform/server/auth/config';
import { inferNativeRegistration } from '@/platform/server/auth/oauth-client-registration';
import { pruneOrphanedOAuthClients } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import { createFileRoute } from '@tanstack/react-router';
import { scheduleFlushAnalytics } from '#flush-scheduler';

const logger = getLogger(['openstory', 'api', 'auth']);

/**
 * RFC 7591 dynamic client registration is open (#1456): the MCP spec expects
 * a client to register itself before the user ever sees a consent screen.
 * Better Auth's own rate limiter is memory-backed and off outside NODE_ENV
 * production, so the endpoint is throttled here with the same per-IP Workers
 * limiter the device-code login uses, and stale registrations are pruned.
 */
const CLIENT_REGISTRATION_PATH = '/api/auth/oauth2/register';

function isClientRegistration(request: Request): boolean {
  return (
    request.method === 'POST' &&
    new URL(request.url).pathname === CLIENT_REGISTRATION_PATH
  );
}

async function guardClientRegistration(request: Request): Promise<void> {
  if (!isClientRegistration(request)) return;
  await assertDeviceLoginRate(request);
  try {
    const pruned = await pruneOrphanedOAuthClients();
    if (pruned > 0) logger.info('pruned orphaned oauth clients', { pruned });
  } catch (error) {
    // Housekeeping must never block a registration.
    logger.warn('orphaned oauth client prune failed', { err: error });
  }
}

/**
 * Better Auth's `user.create` / `session.create` hooks fire
 * `captureProductEvent` (`user_signed_up` / `user_signed_in`, #1088), and
 * that call is fire-and-forget. The posthog-node client is configured
 * `flushAt: 1, flushInterval: 0`, so the HTTP request leaves immediately —
 * but nothing holds the isolate open for it, and on Workers an in-flight
 * fetch is cancelled once the response is returned. Whether the event lands
 * is then a race against teardown: production recorded 36 `user_signed_in`
 * but none for four days, and only two `user_signed_up` ever.
 *
 * Server functions avoid this because their middleware schedules the flush
 * (`src/platform/middleware.fn.ts`); this route has no middleware, so it
 * schedules its own. `scheduleFlushAnalytics` routes through `waitUntil` on
 * Workers, so the response is not delayed.
 */
async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    await guardClientRegistration(request);
  } catch (error) {
    // `assertDeviceLoginRate` throws a ready-made 429 Response.
    if (error instanceof Response) return error;
    throw error;
  }
  const auth = getAuth();
  // A loopback client that does not say it is native is still one
  // (`oauth-client-registration.ts`); the provider would refuse it as `web`.
  const response = await auth.handler(
    isClientRegistration(request)
      ? await inferNativeRegistration(request)
      : request
  );
  await scheduleFlushAnalytics();
  return response;
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
