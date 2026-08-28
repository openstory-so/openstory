/**
 * Dashboard side of device-code login (#1219): look up a pending `user_code`
 * and approve/deny it under the signed-in user's cookie session, via Better
 * Auth's deviceAuthorization plugin. The agent collects the key from
 * GET /api/v1/device/token — no secret passes through the browser.
 */

import { getAuth } from '@/lib/auth/config';
import { resolveUserTeam } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'serverFn', 'device-auth']);

const codeSchema = z.object({ userCode: z.string().min(1).max(16) });

/** Accept `abcd efgh` / `abcd-efgh` etc. for what the plugin stores as `ABCDEFGH`. */
const normalizeUserCode = (raw: string) =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Plugin row status, or `invalid` for unknown/expired codes. */
export type DeviceGrantStatus = 'pending' | 'approved' | 'denied' | 'invalid';

const grantStatus = z.enum(['pending', 'approved', 'denied']);

export const lookupDeviceGrantFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(codeSchema))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ status: DeviceGrantStatus; teamName: string }> => {
      const team = await resolveUserTeam(context.user.id);
      let status: DeviceGrantStatus = 'invalid';
      try {
        // With a session this also *claims* the code for the user — the
        // plugin refuses to approve an unclaimed code. (A code already
        // claimed by another account still reads `pending`; approving it
        // then fails with `access_denied`.)
        const found = await getAuth().api.deviceVerify({
          headers: getRequestHeaders(),
          query: { user_code: normalizeUserCode(data.userCode) },
        });
        status = grantStatus.safeParse(found.status).data ?? 'invalid';
      } catch (error) {
        if (!(error instanceof APIError)) throw error;
      }
      return { status, teamName: team?.teamName ?? '' };
    }
  );

/** Plugin OAuth error code on failure (e.g. `access_denied` = claimed by another user). */
export const decideDeviceGrantFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(codeSchema.extend({ approve: z.boolean() })))
  .handler(async ({ data, context }): Promise<{ error: string | null }> => {
    const auth = getAuth();
    const args = {
      headers: getRequestHeaders(),
      body: { userCode: normalizeUserCode(data.userCode) },
    };
    let error: string | null = null;
    try {
      await (data.approve
        ? auth.api.deviceApprove(args)
        : auth.api.deviceDeny(args));
    } catch (err) {
      if (!(err instanceof APIError)) throw err;
      error =
        z.object({ error: z.string() }).safeParse(err.body).data?.error ??
        String(err.status);
    }
    logger[error ? 'warn' : 'info']('device grant decided', {
      userId: context.user.id,
      teamId: context.teamId,
      approve: data.approve,
      error,
    });
    return { error };
  });
