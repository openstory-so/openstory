/**
 * Who pays a gateway call and what the app earns on it
 * (docs/architecture/model-gateway.md § Margin and SKUs). Read once at
 * submit and snapshotted: the run reads none of it again.
 */

import type { Microdollars } from '@/billing/money';
import type { SkuChargeGuard } from '@/billing/server/db/spend-cap';
import { InsufficientCreditsError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { appliedMarginBps } from '@/gateway/apps';
import type { GatewayAppOfClient } from '@/gateway/server/db/gateway-apps';
import type { GatewayGrantStanding } from '@/gateway/server/db/gateway-grants';
import {
  AppSuspendedError,
  GrantRequiredError,
  SpendCapExceededError,
} from '@/gateway/server/errors';

/** The margin a charge adds and who it is paid to. */
export type AppMargin = { bps: number; payeeOrganizationId: string };

export type UserPays = {
  oauthClientId: string;
  /** The registered, active app the client is; null when it is not one. */
  app: GatewayAppOfClient | null;
  standing: GatewayGrantStanding;
  /** Null when nothing is earned: no app, the app's own organization pays, or nothing accepted. */
  appMargin: AppMargin | null;
};

/**
 * A user-pays caller's app and grant: refused when the app is suspended or
 * the grant is not live. The margin is the lower of the app's and the one
 * the user accepted, and none when the payer is the app's own organization.
 */
export async function resolveUserPays(
  scopedDb: ScopedDb,
  oauthClientId: string
): Promise<UserPays> {
  const app = await scopedDb.gatewayApps.getByOAuthClient(oauthClientId);
  if (app?.status === 'suspended') throw new AppSuspendedError();
  const standing = await scopedDb.gatewayGrants.getStanding(
    oauthClientId,
    scopedDb.organizationId
  );
  if (!standing) throw new GrantRequiredError();
  const bps =
    app && app.organizationId !== scopedDb.organizationId
      ? appliedMarginBps(app.marginBps, standing.accepted.marginBps)
      : 0;
  return {
    oauthClientId,
    app,
    standing,
    appMargin:
      app && bps > 0 ? { bps, payeeOrganizationId: app.organizationId } : null,
  };
}

/**
 * Hold a charge. A user-pays hold carries its client and is refused in the
 * same statement when it would pass the grant's cap; the refusal is then
 * told apart by reading the grant again.
 */
export async function holdCharge(
  scopedDb: ScopedDb,
  hold: Microdollars,
  idempotencyKey: string,
  userPays: {
    oauthClientId: string;
    appId: string | null;
    sku?: SkuChargeGuard;
  } | null
): Promise<{
  reservationId: string;
  remaining: Microdollars;
  replay: boolean;
}> {
  const result = await scopedDb.billing.createReservation(hold, {
    idempotencyKey,
    ...(userPays && { spendCap: userPays }),
  });
  if (result.ok) return result;
  if (userPays) {
    const standing = await scopedDb.gatewayGrants.getStanding(
      userPays.oauthClientId,
      scopedDb.organizationId
    );
    if (!standing) throw new GrantRequiredError();
    if (hold > standing.remainingMicros) {
      throw new SpendCapExceededError(standing, hold);
    }
  }
  throw new InsufficientCreditsError('Insufficient credits for this charge');
}
