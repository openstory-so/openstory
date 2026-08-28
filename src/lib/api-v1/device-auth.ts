/**
 * Device-code login for the public API (#1219, RFC 8628 shape).
 *
 * Thin layer over Better Auth's `deviceAuthorization` plugin, which owns the
 * code lifecycle. The one thing the plugin can't do is hand back an API key —
 * its `/device/token` mints a *session* — so `exchangeDeviceCode` redeems the
 * code, swaps the session for a normal `osk_` key owned by the approving user
 * (revocable under Settings → Developer), and discards the session.
 */

import { getAuth } from '@/lib/auth/config';
import { pruneExpiredDeviceCodes, resolveUserTeam } from '@/lib/db/scoped';
import { APIError } from 'better-auth/api';
import { env as workerEnv } from 'cloudflare:workers';
import { z } from 'zod';
import { apiJsonError } from './errors';

/** Single first-party client; the plugin requires a `client_id` on the wire. */
export const DEVICE_CLIENT_ID = 'openstory-api';
/** Dashboard approval page (`src/routes/_app/device.tsx`); auth/config.ts builds `verificationUri` from it. */
export const DEVICE_VERIFICATION_PATH = '/device';

export { pruneExpiredDeviceCodes };

export type DeviceTokenResult =
  | {
      status:
        | 'authorization_pending'
        | 'slow_down'
        | 'expired_token'
        | 'access_denied';
    }
  | { status: 'approved'; apiKey: string; team: { id: string; name: string } };

const PLUGIN_ERRORS = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
] as const;
const pluginErrorCode = z.object({ error: z.enum(PLUGIN_ERRORS) });
const oauthErrorBody = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/**
 * Per-IP throttle for the unauthenticated `/api/v1/device/*` routes (they
 * call `auth.api.*` directly, so neither Better Auth's limiter nor the api-key
 * plugin's covers them). Throws a ready 429 Response, which `runApiV1Handler`
 * passes through.
 */
export async function assertDeviceLoginRate(request: Request): Promise<void> {
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  // Via `cloudflare:workers` so the binding is typed (see storage-cloudflare.ts).
  const { success } = await workerEnv.DEVICE_LOGIN_RATE_LIMITER.limit({ key });
  if (!success) {
    throw apiJsonError(
      429,
      'rate_limited',
      'Too many device-login requests from this address. Retry in a minute.',
      undefined,
      { 'Retry-After': '60' }
    );
  }
}

/**
 * One poll of the plugin's `/device/token`. Pending/denied/expired come back as
 * statuses rather than throws; unknown codes read as `expired_token` so the
 * endpoint isn't an existence oracle. Approval consumes the code in the plugin
 * and mints the key here — a second call with the same code is `invalid_grant`
 * to the plugin, which we fold into `expired_token` below. Anything that fails
 * after the plugin consumed the code (team lookup, key creation) burns it: the
 * agent gets one 500, then 410s, and must start again.
 */
export async function exchangeDeviceCode(
  deviceCode: string
): Promise<DeviceTokenResult> {
  const auth = getAuth();
  let accessToken: string;
  try {
    ({ access_token: accessToken } = await auth.api.deviceToken({
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      },
    }));
  } catch (error) {
    if (error instanceof APIError) {
      const parsed = pluginErrorCode.safeParse(error.body);
      if (parsed.success) return { status: parsed.data.error };
      const oauth = oauthErrorBody.safeParse(error.body);
      // invalid_grant = unknown/used code; anything else is a real failure.
      if (oauth.data?.error === 'invalid_grant')
        return { status: 'expired_token' };
      // OAuth-style APIErrors carry an empty `.message`; surface the body.
      if (oauth.success) {
        throw new Error(
          `Device token exchange failed: ${oauth.data.error_description ?? oauth.data.error}`,
          { cause: error }
        );
      }
    }
    throw error;
  }

  const { internalAdapter } = await auth.$context;
  const found = await internalAdapter.findSession(accessToken);
  // The session was only ever a carrier for the user id; never leave it live.
  await internalAdapter.deleteSession(accessToken);
  if (!found) throw new Error('Device login session vanished before exchange');
  const userId = found.user.id;

  const team = await resolveUserTeam(userId);
  if (!team) throw new Error('No team found for user');

  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `Agent login · ${new Date().toISOString().slice(0, 10)}`,
      prefix: 'osk_',
    },
  });
  return {
    status: 'approved',
    apiKey: created.key,
    team: { id: team.teamId, name: team.teamName },
  };
}
