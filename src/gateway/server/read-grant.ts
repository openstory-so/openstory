/**
 * `GET /api/v1/gateway/grant`: what the caller may still spend this UTC
 * month. An OAuth caller reads its grant; an `osk_` key reads "app pays".
 */

import { utcMonthStart } from '@/billing/server/db/spend-cap';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  gatewayGrantDocument,
  type GatewayGrantResource,
} from '@/gateway/server/api-documents';
import { GrantRequiredError } from '@/gateway/server/errors';

export async function readGatewayGrant(
  scopedDb: ScopedDb,
  oauthClientId: string | null,
  now = new Date()
): Promise<GatewayGrantResource> {
  const periodStart = utcMonthStart(now);
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1)
  );
  const standing = oauthClientId
    ? await scopedDb.gatewayGrants.getStanding(
        oauthClientId,
        scopedDb.organizationId,
        now
      )
    : null;
  if (oauthClientId && !standing) throw new GrantRequiredError();
  return gatewayGrantDocument({
    organizationId: scopedDb.organizationId,
    clientId: oauthClientId,
    standing,
    periodStart,
    periodEnd,
  });
}
