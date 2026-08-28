/**
 * POST /api/v1/device/code — start a device-code login (RFC 8628 shape, #1219).
 *
 * Unauthenticated: this is how an agent gets a key in the first place. Returns
 * the secret `device_code` (for polling) and the short `user_code` the user
 * types at `verification_url`. Backed by Better Auth's deviceAuthorization
 * plugin; this wrapper only fixes the client id and adds the HAL poll link.
 */

import {
  assertDeviceLoginRate,
  DEVICE_CLIENT_ID,
  DEVICE_VERIFICATION_PATH,
  pruneExpiredDeviceCodes,
} from '@/lib/api-v1/device-auth';
import { runApiV1Handler } from '@/lib/api-v1/errors';
import { API_V1_BASE } from '@/lib/api-v1/hal';
import { getAuth } from '@/lib/auth/config';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/device/code')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runApiV1Handler(async () => {
          await assertDeviceLoginRate(request);
          await pruneExpiredDeviceCodes();
          const code = await getAuth().api.deviceCode({
            body: { client_id: DEVICE_CLIENT_ID },
          });
          // The plugin's verification_uri is built from VITE_APP_URL, a
          // deploy-time constant; use the origin the agent actually reached
          // (PR previews, other local ports).
          const verificationUrl = new URL(
            DEVICE_VERIFICATION_PATH,
            new URL(request.url).origin
          );
          const verificationUrlComplete = new URL(verificationUrl);
          verificationUrlComplete.searchParams.set('user_code', code.user_code);
          return Response.json(
            {
              device_code: code.device_code,
              user_code: code.user_code,
              verification_url: verificationUrl.toString(),
              verification_url_complete: verificationUrlComplete.toString(),
              expires_in: code.expires_in,
              interval: code.interval,
              _links: {
                poll: {
                  href: `${API_V1_BASE}/device/token?device_code=${encodeURIComponent(code.device_code)}{&wait}`,
                  method: 'GET',
                  templated: true,
                  title:
                    'Poll for the API key (supports ?wait long-polling; otherwise respect `interval` between calls)',
                },
              },
            },
            { status: 201, headers: { 'Cache-Control': 'no-store' } }
          );
        }),
    },
  },
});
