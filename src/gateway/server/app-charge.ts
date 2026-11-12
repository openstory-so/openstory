/**
 * `POST /api/v1/gateway/charges` (docs/architecture/model-gateway.md §
 * Margin and SKUs): a registered app charges the consenting user's
 * organization for one of its declared SKUs. User-pays only, capped like a
 * job, settled at once as one `app_charge` line to the app's organization.
 * A replayed `Idempotency-Key` returns the charge it first made.
 */

import { micros, type Microdollars } from '@/billing/money';
import { releaseReservationOnThrow } from '@/billing/server/preflight';
import type { SettledChargeLine } from '@/billing/server/db/billing';
import { InsufficientCreditsError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  AppNotRegisteredError,
  IdempotencyKeyError,
  OwnOrganizationChargeError,
  SkuNotApprovedError,
  UnknownSkuError,
  UserPaysOnlyError,
} from '@/gateway/server/errors';
import { holdCharge, resolveUserPays } from '@/gateway/server/user-pays';

export type AppChargeResult = {
  id: string;
  sku: string;
  totalMicros: Microdollars;
  lines: Pick<SettledChargeLine, 'kind' | 'amountMicros'>[];
  createdAt: Date;
  replay: boolean;
};

/** The hold's key; the settle's is this plus `:settle`. Scoped to the client, length-prefixed so no two collide. */
function chargeKey(oauthClientId: string, idempotencyKey: string): string {
  return `app-charge:${oauthClientId.length}:${oauthClientId}:${idempotencyKey}`;
}

function toResult(
  sku: string,
  charge: {
    transactionId: string;
    captured: Microdollars;
    createdAt: Date;
    lines: SettledChargeLine[];
  },
  replay: boolean
): AppChargeResult {
  return {
    id: charge.transactionId,
    sku: charge.lines.find((line) => line.sku)?.sku ?? sku,
    totalMicros: charge.captured,
    lines: charge.lines.map(({ kind, amountMicros }) => ({
      kind,
      amountMicros,
    })),
    createdAt: charge.createdAt,
    replay,
  };
}

export async function createAppCharge(input: {
  scopedDb: ScopedDb;
  /** Null for an `osk_` key or a session, which cannot charge. */
  oauthClientId: string | null;
  idempotencyKey: string | null;
  sku: string;
}): Promise<AppChargeResult> {
  const { scopedDb, oauthClientId } = input;
  if (!oauthClientId) throw new UserPaysOnlyError();
  if (!input.idempotencyKey) {
    throw new IdempotencyKeyError('IDEMPOTENCY_KEY_REQUIRED');
  }
  const key = chargeKey(oauthClientId, input.idempotencyKey);
  const settleKey = `${key}:settle`;
  const settled = await scopedDb.billing.getSettledCharge(settleKey);
  if (settled) return toResult(input.sku, settled, true);

  const userPays = await resolveUserPays(scopedDb, oauthClientId);
  const { app, standing } = userPays;
  if (!app) throw new AppNotRegisteredError();
  if (app.organizationId === scopedDb.organizationId) {
    throw new OwnOrganizationChargeError();
  }
  const sku = await scopedDb.gatewayApps.getActiveSku(app.id, input.sku);
  if (!sku) throw new UnknownSkuError(input.sku);
  const accepted = standing.accepted.skuPrices[sku.key];
  if (accepted === undefined || sku.priceMicros > accepted) {
    throw new SkuNotApprovedError({
      sku: sku.key,
      priceMicros: sku.priceMicros,
      acceptedPriceMicros: accepted ?? null,
    });
  }

  const price = micros(sku.priceMicros);
  const hold = await holdCharge(scopedDb, price, key, {
    oauthClientId,
    appId: app.id,
  });
  // A held key from a first attempt that never settled must be for the same price.
  if (hold.replay && hold.remaining !== price) {
    const raced = await scopedDb.billing.getSettledCharge(settleKey);
    if (raced) return toResult(input.sku, raced, true);
    throw new IdempotencyKeyError('IDEMPOTENCY_CONFLICT');
  }
  const result = await releaseReservationOnThrow(
    scopedDb,
    hold.reservationId,
    () =>
      scopedDb.billing.settleReservation(
        hold.reservationId,
        [
          {
            kind: 'app_charge',
            amountMicros: price,
            payeeOrganizationId: app.organizationId,
            sku: sku.key,
          },
        ],
        {
          idempotencyKey: settleKey,
          description: `App charge (${sku.name})`,
          metadata: { appId: app.id, sku: sku.key },
          attribution: { oauthClientId, appId: app.id },
        }
      )
  );
  if (!result.ok || !result.transactionId) {
    await scopedDb.billing.zeroReservation(hold.reservationId);
    throw new InsufficientCreditsError('Insufficient credits for this charge');
  }
  const charge = await scopedDb.billing.getSettledCharge(settleKey);
  if (!charge) throw new Error(`App charge ${result.transactionId} not found`);
  return toResult(sku.key, charge, result.replay);
}
