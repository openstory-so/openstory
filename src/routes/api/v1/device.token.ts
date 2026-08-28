/**
 * GET /api/v1/device/token?device_code=…&wait=60s — collect the API key once
 * the user has approved the device-code login in the dashboard (#1219).
 *
 * Unauthenticated (the `device_code` is the credential). While pending,
 * answers 428 `authorization_pending`; `?wait` holds the request open (same
 * convention as sequence status) so an agent needn't busy-poll. Polling faster
 * than the advertised `interval` without `?wait` gets 429 `slow_down`.
 * Terminal: 200 `{ api_key, team }` (once — the code is consumed),
 * 403 `access_denied`, 410 `expired_token` (also for unknown/used codes).
 */

import {
  assertDeviceLoginRate,
  exchangeDeviceCode,
} from '@/lib/api-v1/device-auth';
import { apiJsonError, runApiV1Handler } from '@/lib/api-v1/errors';
import { API_V1_BASE } from '@/lib/api-v1/hal';
import { getWaitMs, longPoll } from '@/lib/api-v1/wait';
import { ValidationError } from '@/lib/errors';
import { createFileRoute } from '@tanstack/react-router';

/**
 * Matches the plugin's `interval`. The last poll before the `?wait` deadline
 * can still land early (longPoll clamps the final sleep to the remaining
 * time), which the `slow_down` case below absorbs.
 */
const POLL_INTERVAL_MS = 5_000;

export const Route = createFileRoute('/api/v1/device/token')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        runApiV1Handler(async () => {
          await assertDeviceLoginRate(request);
          const waitMs = getWaitMs(request);
          const deviceCode = new URL(request.url).searchParams.get(
            'device_code'
          );
          if (!deviceCode) {
            throw new ValidationError('Missing "device_code" parameter.');
          }

          const { value } = await longPoll({
            waitMs,
            signal: request.signal,
            pollIntervalMs: POLL_INTERVAL_MS,
            load: () => exchangeDeviceCode(deviceCode),
            // Only a decision ends the wait; pending/slow_down just keep polling
            // (a constant cursor so a pending→slow_down flip doesn't return).
            cursor: () => '',
            done: (v) =>
              v.status !== 'authorization_pending' && v.status !== 'slow_down',
          });

          const pending = () =>
            apiJsonError(
              428,
              'authorization_pending',
              'The user has not approved this login yet. Keep polling (use ?wait).'
            );

          switch (value.status) {
            case 'authorization_pending':
              return pending();
            case 'slow_down':
              // Mid-wait the server paced itself; only a bare poll is "too fast".
              if (waitMs > 0) return pending();
              return apiJsonError(
                429,
                'slow_down',
                'Polling too fast. Wait `interval` seconds between polls, or use ?wait.',
                undefined,
                { 'Retry-After': String(POLL_INTERVAL_MS / 1000) }
              );
            case 'access_denied':
              return apiJsonError(
                403,
                'access_denied',
                'The user denied this login.'
              );
            case 'expired_token':
              return apiJsonError(
                410,
                'expired_token',
                'This device code is unknown, expired, or already used. Start again at POST /api/v1/device/code.'
              );
            case 'approved':
              return Response.json(
                {
                  api_key: value.apiKey,
                  team: value.team,
                  _links: {
                    root: {
                      href: API_V1_BASE,
                      method: 'GET',
                      title: 'API root',
                    },
                  },
                },
                { headers: { 'Cache-Control': 'no-store' } }
              );
          }
        }),
    },
  },
});
