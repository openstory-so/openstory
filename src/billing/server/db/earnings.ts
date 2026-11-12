/**
 * `gateway_earnings` (docs/architecture/model-gateway.md § Earnings). Rows
 * are written by `billing.settleReservation` with their payee line. The
 * scoped methods read a payee's earnings and cancel a payer's pending one;
 * the sweep functions mature due rows across organizations.
 */

import type { EarningStatus } from '@/billing/charge-lines';
import { type Microdollars, micros } from '@/billing/money';
import type { Database } from '@/platform/server/db/client';
import { gatewayEarnings, transactions } from '@/platform/server/db/schema';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

/** One app's earnings for its organization. */
export type AppEarnings = {
  appId: string;
  pendingMicros: Microdollars;
  maturedMicros: Microdollars;
  recent: {
    id: string;
    amountMicros: Microdollars;
    status: EarningStatus;
    availableAt: Date;
    createdAt: Date;
  }[];
};

/** An earning the sweep just matured: what to credit and where. */
export type ClaimedEarning = {
  id: string;
  payeeOrganizationId: string;
  appId: string;
  chargeLineId: string;
  amountMicros: number;
};

/** The wallet credit's idempotency key: one per earning, ever. */
export function earningCreditKey(earningId: string): string {
  return `earning:${earningId}`;
}

export function createEarningsMethods(db: Database, organizationId: string) {
  return {
    /** Pending and matured totals and the latest rows per app this organization is paid for. */
    byApp: async (
      appIds: string[],
      recentPerApp = 5
    ): Promise<AppEarnings[]> => {
      if (appIds.length === 0) return [];
      const mine = and(
        eq(gatewayEarnings.payeeOrganizationId, organizationId),
        inArray(gatewayEarnings.appId, appIds)
      );
      const ranked = db
        .select({
          id: gatewayEarnings.id,
          appId: gatewayEarnings.appId,
          amountMicros: gatewayEarnings.amountMicros,
          status: gatewayEarnings.status,
          availableAt: gatewayEarnings.availableAt,
          createdAt: gatewayEarnings.createdAt,
          rank: sql<number>`row_number() over (partition by ${gatewayEarnings.appId} order by ${gatewayEarnings.createdAt} desc, ${gatewayEarnings.id} desc)`.as(
            'rank'
          ),
        })
        .from(gatewayEarnings)
        .where(mine)
        .as('ranked');
      const [totals, recent] = await Promise.all([
        db
          .select({
            appId: gatewayEarnings.appId,
            status: gatewayEarnings.status,
            amountMicros: sql<number>`sum(${gatewayEarnings.amountMicros})`,
          })
          .from(gatewayEarnings)
          .where(mine)
          .groupBy(gatewayEarnings.appId, gatewayEarnings.status),
        // Ranked in SQL so only `recentPerApp` rows per app leave D1.
        db
          .select({
            id: ranked.id,
            appId: ranked.appId,
            amountMicros: ranked.amountMicros,
            status: ranked.status,
            availableAt: ranked.availableAt,
            createdAt: ranked.createdAt,
          })
          .from(ranked)
          .where(lte(ranked.rank, recentPerApp))
          .orderBy(desc(ranked.createdAt), desc(ranked.id)),
      ]);
      return appIds.map((appId) => {
        const total = (status: EarningStatus) =>
          micros(
            Number(
              totals.find((row) => row.appId === appId && row.status === status)
                ?.amountMicros ?? 0
            )
          );
        return {
          appId,
          pendingMicros: total('pending'),
          maturedMicros: total('matured'),
          recent: recent
            .filter((row) => row.appId === appId)
            .map(({ appId: _app, ...row }) => ({
              ...row,
              amountMicros: micros(row.amountMicros),
            })),
        };
      });
    },

    /**
     * Cancel a pending earning on a charge this organization paid, for a
     * refund. A matured or cancelled one is left alone; returns whether it changed.
     */
    cancelPending: async (earningId: string): Promise<boolean> => {
      const rows = await db
        .update(gatewayEarnings)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(
          and(
            eq(gatewayEarnings.id, earningId),
            eq(gatewayEarnings.payerOrganizationId, organizationId),
            eq(gatewayEarnings.status, 'pending')
          )
        )
        .returning({ id: gatewayEarnings.id });
      return rows.length > 0;
    },
  };
}

/** Pending earnings whose hold has passed, oldest first. */
export async function listDueEarningIds(
  db: Database,
  now: Date,
  limit: number
): Promise<string[]> {
  const rows = await db
    .select({ id: gatewayEarnings.id })
    .from(gatewayEarnings)
    .where(
      and(
        eq(gatewayEarnings.status, 'pending'),
        lte(gatewayEarnings.availableAt, now)
      )
    )
    .orderBy(asc(gatewayEarnings.availableAt), asc(gatewayEarnings.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * pending → matured, only past its hold. Exactly one caller gets the row
 * back; a cancel after it finds nothing pending.
 */
export async function claimDueEarning(
  db: Database,
  earningId: string,
  now: Date
): Promise<ClaimedEarning | null> {
  const [row] = await db
    .update(gatewayEarnings)
    .set({ status: 'matured', maturedAt: now })
    .where(
      and(
        eq(gatewayEarnings.id, earningId),
        eq(gatewayEarnings.status, 'pending'),
        lte(gatewayEarnings.availableAt, now)
      )
    )
    .returning({
      id: gatewayEarnings.id,
      payeeOrganizationId: gatewayEarnings.payeeOrganizationId,
      appId: gatewayEarnings.appId,
      chargeLineId: gatewayEarnings.chargeLineId,
      amountMicros: gatewayEarnings.amountMicros,
    });
  return row ?? null;
}

/** Matured earnings with no wallet credit recorded, matured before `before`. */
export async function listUncreditedEarnings(
  db: Database,
  before: Date,
  limit: number
): Promise<ClaimedEarning[]> {
  return db
    .select({
      id: gatewayEarnings.id,
      payeeOrganizationId: gatewayEarnings.payeeOrganizationId,
      appId: gatewayEarnings.appId,
      chargeLineId: gatewayEarnings.chargeLineId,
      amountMicros: gatewayEarnings.amountMicros,
    })
    .from(gatewayEarnings)
    .where(
      and(
        eq(gatewayEarnings.status, 'matured'),
        isNull(gatewayEarnings.transactionId),
        lte(gatewayEarnings.maturedAt, before)
      )
    )
    .orderBy(asc(gatewayEarnings.maturedAt))
    .limit(limit);
}

/** The `credit_earned` row an earning matured into, by its key; null when none. */
export async function findEarningCredit(
  db: Database,
  earning: Pick<ClaimedEarning, 'id' | 'payeeOrganizationId'>
): Promise<string | null> {
  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, earning.payeeOrganizationId),
        eq(transactions.idempotencyKey, earningCreditKey(earning.id))
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/** Link a matured earning to its wallet credit, once. */
export async function recordEarningCredit(
  db: Database,
  earningId: string,
  transactionId: string
): Promise<void> {
  await db
    .update(gatewayEarnings)
    .set({ transactionId })
    .where(
      and(
        eq(gatewayEarnings.id, earningId),
        eq(gatewayEarnings.status, 'matured'),
        isNull(gatewayEarnings.transactionId)
      )
    );
}
