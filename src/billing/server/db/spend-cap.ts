/**
 * The SQL of a user-pays spend cap (docs/architecture/model-gateway.md § The
 * cap). One definition of "spent" and "held", shared by the reservation's
 * guard and every read that shows a grant's standing.
 */

import {
  chargeLines,
  creditReservations,
  gatewayGrants,
} from '@/platform/server/db/schema';
import { and, eq, isNull, sql, type Column, type SQL } from 'drizzle-orm';

/** The first instant of the UTC calendar month `now` is in. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The scope of `now` for (payer, client), in epoch seconds. */
export function spendCapScope<
  O extends string | Column,
  C extends string | Column,
>(
  organizationId: O,
  oauthClientId: C,
  now: Date
): SpendCapScope & { organizationId: O; oauthClientId: C } {
  return {
    organizationId,
    oauthClientId,
    monthStartSeconds: Math.floor(utcMonthStart(now).getTime() / 1000),
    nowSeconds: Math.floor(now.getTime() / 1000),
  };
}

export type SpendCapScope = {
  /** The payer; a column correlates the sums to an outer row. */
  organizationId: string | Column;
  oauthClientId: string | Column;
  /** The UTC month's first second, in epoch seconds. */
  monthStartSeconds: number;
  nowSeconds: number;
};

/** Settled lines this UTC month for the payer and client. */
export function monthSpendSql(scope: SpendCapScope): SQL<number> {
  return sql<number>`coalesce((
    select sum(${chargeLines.amountMicros})
    from ${chargeLines}
    where ${chargeLines.organizationId} = ${scope.organizationId}
      and ${chargeLines.oauthClientId} = ${scope.oauthClientId}
      and ${chargeLines.createdAt} >= ${scope.monthStartSeconds}
  ), 0)`;
}

/** Unexpired, unspent holds for the payer and client. */
export function liveHoldsSql(scope: SpendCapScope): SQL<number> {
  return sql<number>`coalesce((
    select sum(${creditReservations.remainingAmount})
    from ${creditReservations}
    where ${creditReservations.organizationId} = ${scope.organizationId}
      and ${creditReservations.oauthClientId} = ${scope.oauthClientId}
      and ${creditReservations.remainingAmount} > 0
      and ${creditReservations.expiresAt} > ${scope.nowSeconds}
  ), 0)`;
}

/** The live grant of (client, user, payer). */
export function liveGrantWhere(
  organizationId: string,
  oauthClientId: string,
  userId: string
) {
  return and(
    eq(gatewayGrants.oauthClientId, oauthClientId),
    eq(gatewayGrants.userId, userId),
    eq(gatewayGrants.organizationId, organizationId),
    isNull(gatewayGrants.revokedAt)
  );
}

/** True when a live grant exists and `amountMicros` more fits under its cap. */
export function fitsUnderCapSql(
  scope: SpendCapScope & { organizationId: string; oauthClientId: string },
  userId: string,
  amountMicros: number
): SQL {
  return sql`exists (
    select 1 from ${gatewayGrants}
    where ${liveGrantWhere(scope.organizationId, scope.oauthClientId, userId)}
      and ${gatewayGrants.monthlyCapMicros} >= ${monthSpendSql(scope)} + ${liveHoldsSql(scope)} + ${amountMicros}
  )`;
}
