/**
 * Scoped Billing Sub-module
 * Organization-scoped credit operations: balance, deductions, transactions, settings.
 * All monetary values are in Microdollars (1 USD = 1,000,000).
 */

import {
  AUTO_TOPUP_COOLDOWN_MS,
  AUTO_TOPUP_DECLINE_COOLDOWN_MS,
  calculateExpiryDate,
  isStripeEnabled,
  MIN_TOPUP_AMOUNT_MICROS,
  RESERVATION_TTL_MS,
  totalCheckoutCents,
} from '@/billing/constants';
import {
  type Microdollars,
  micros,
  microsToDisplayUsd,
  microsToUsd,
  negateMicros,
  subtractMicros,
  ZERO_MICROS,
} from '@/billing/money';
import type { Database } from '@/platform/server/db/client';
import {
  creditBatches,
  creditReservations,
  credits,
  organizationBillingSettings,
  transactions,
} from '@/platform/server/db/schema/credits';
import type {
  CreditBatchSource,
  OrganizationBillingSetting,
  TransactionType,
} from '@/platform/server/db/schema/credits';
import { notifyAutoTopUpFailed } from '@/billing/server/notify-auto-top-up-failed';
import { createOrganizationManagementMethods } from '@/platform/server/db/scoped/organization-management';
import {
  type ChargeLineKind,
  EARNING_HOLD_DAYS,
  inFillOrder,
} from '@/billing/charge-lines';
import {
  giftRedeemHolderReason,
  normalizeGiftCode,
  type GiftRedeemResult,
} from '@/billing/gift-redeem';
import { ValidationError } from '@/platform/errors';
import { getBillingChannel } from '@/platform/realtime';
import { and, count, desc, eq, gte, isNull, notExists, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { generateId } from '@/platform/id';
import {
  chargeLines,
  gatewayEarnings,
  giftTokenRedemptions,
  giftTokens,
} from '@/platform/server/db/schema';

import { getLogger } from '@/platform/logger';
import { onPrimary } from '@/platform/server/db/d1-session';
import { fitsUnderCapSql, spendCapScope } from '@/billing/server/db/spend-cap';

/**
 * Best-effort live balance push for the credit pill (#1090).
 *
 * **Awaited** (emit itself never throws): request-scoped paths like enhance
 * script finish the streaming response right after `deductCredits`, and a
 * fire-and-forget DO fetch can be dropped when the isolate tears down.
 * Call only after a *new* transaction row was inserted (not on idempotent
 * replay).
 */
async function emitFundsUpdated(opts: {
  organizationId: string;
  balance: Microdollars;
  reserved: Microdollars;
  available: Microdollars;
  asOfMs: number;
  /** Signed ledger amount (negative for usage). Zero when only a hold changed. */
  amountMicros: Microdollars;
  transactionId?: string;
  type?: TransactionType;
}): Promise<void> {
  await getBillingChannel(opts.organizationId).emit('billing.balance:updated', {
    organizationId: opts.organizationId,
    balanceUsd: microsToUsd(opts.balance),
    availableUsd: microsToUsd(opts.available),
    reservedUsd: microsToUsd(opts.reserved),
    asOfMs: opts.asOfMs,
    amountUsd: microsToUsd(opts.amountMicros),
    ...(opts.transactionId != null && opts.type
      ? { transactionId: opts.transactionId, type: opts.type }
      : {}),
  });
}

const logger = getLogger(['openstory', 'db', 'billing']);

/**
 * Duck-type Stripe card errors. This module is in the client graph via
 * scoped-db middleware, so a static `stripe` import would ship the Node
 * SDK to the browser (#1253).
 */
function stripeDeclineCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  if (err.type !== 'StripeCardError' && err.type !== 'card_error') return null;
  const declineCode =
    'decline_code' in err && typeof err.decline_code === 'string'
      ? err.decline_code
      : null;
  const code = 'code' in err && typeof err.code === 'string' ? err.code : null;
  return declineCode ?? code ?? 'card_declined';
}

type TryDebitResult =
  | {
      ok: true;
      newBalance: Microdollars;
      chargedAmount: Microdollars;
      transactionId: string;
      replay: boolean;
    }
  | { ok: false };

export type CreateReservationResult =
  | {
      ok: true;
      reservationId: string;
      remaining: Microdollars;
      replay: boolean;
    }
  | { ok: false };

export type GrowReservationResult =
  | { ok: true; remaining: Microdollars }
  | { ok: false };

export type CaptureReservationResult =
  | { ok: false; reason: 'missing' }
  | {
      ok: true;
      captured: Microdollars;
      skippedDeltaMicros?: Microdollars;
    };

export type ChargeLineInput = {
  kind: ChargeLineKind;
  amountMicros: Microdollars;
  /** Null is the platform. */
  payeeOrganizationId?: string | null;
  sku?: string | null;
};

/** What every line of one charge is attributed to. */
export type ChargeLineAttribution = {
  gatewayJobId?: string | null;
  oauthClientId?: string | null;
  appId?: string | null;
};

export type SettledChargeLine = {
  id: string;
  kind: ChargeLineKind;
  amountMicros: Microdollars;
  payeeOrganizationId: string | null;
  sku: string | null;
};

export type SettleReservationResult =
  | { ok: false; reason: 'missing' }
  | {
      ok: true;
      captured: Microdollars;
      skippedDeltaMicros?: Microdollars;
      /** Null when nothing was debited; then there are no lines. */
      transactionId: string | null;
      lines: SettledChargeLine[];
      replay: boolean;
    };

function skippedCaptureDelta(
  actualMicros: Microdollars,
  captured: Microdollars
): Microdollars | undefined {
  return actualMicros > captured
    ? subtractMicros(actualMicros, captured)
    : undefined;
}

function mapBatchSource(
  type: TransactionType,
  metadata?: Record<string, unknown>
): CreditBatchSource {
  if (metadata?.giftTokenId) return 'gift_code';
  if (metadata?.autoTopUp) return 'auto_topup';
  if (type === 'credit_adjustment') return 'adjustment';
  if (type === 'credit_earned') return 'earned';
  return 'stripe_checkout';
}

/**
 * Read-only billing methods — balance checks, transaction history, settings.
 */
function createBillingReadMethods(db: Database, organizationId: string) {
  // Money reads stay on the primary: a replica can pass a spend another session just made (#2233).
  const getBalance = (): Promise<Microdollars> => onPrimary(readBalance);

  async function readBalance(): Promise<Microdollars> {
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId))
      .limit(1);

    if (!row) {
      await db
        .insert(credits)
        .values({ organizationId, balance: 0 })
        .onConflictDoNothing({ target: credits.organizationId });
      return ZERO_MICROS;
    }

    return micros(row.balance);
  }

  /**
   * Posted balance, unexpired holds, and D1's clock at the read, in one
   * batch so no write lands between them. `asOfMs` orders snapshots: D1
   * serializes a database's statements, so a later read has a later clock
   * whichever isolate took it (#1881).
   */
  const readAvailable = (now = new Date(), reservationId?: string) =>
    onPrimary(() => readAvailableOnPrimary(now, reservationId));

  async function readAvailableOnPrimary(
    now: Date,
    reservationId?: string
  ): Promise<{
    balance: Microdollars;
    reserved: Microdollars;
    available: Microdollars;
    asOfMs: number;
  }> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const [balanceRows, [held]] = await db.batch([
      db
        .select({ balance: credits.balance })
        .from(credits)
        .where(eq(credits.organizationId, organizationId))
        .limit(1),
      db
        .select({
          total: sql<number>`coalesce(sum(${creditReservations.remainingAmount}), 0)`,
          asOfMs: sql<number>`cast(unixepoch('subsecond') * 1000 as integer)`,
        })
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.organizationId, organizationId),
            reservationId
              ? sql`${creditReservations.id} <> ${reservationId}`
              : undefined,
            sql`${creditReservations.remainingAmount} > 0`,
            sql`${creditReservations.expiresAt} > ${nowSeconds}`
          )
        ),
    ]);
    const balance = balanceRows[0]
      ? micros(balanceRows[0].balance)
      : await getBalance();
    const reserved = micros(Number(held?.total ?? 0));
    const available =
      balance > reserved ? subtractMicros(balance, reserved) : ZERO_MICROS;
    // A NaN would compare false both ways and turn ordering off unnoticed.
    const asOfMs = Number(held?.asOfMs);
    if (!Number.isFinite(asOfMs)) {
      throw new Error(`D1 returned no clock for the balance read: ${asOfMs}`);
    }
    return { balance, reserved, available, asOfMs };
  }

  const getAvailable = (now = new Date()) => readAvailable(now);

  async function hasEnoughCredits(
    estimatedCostMicros: Microdollars,
    reservationId?: string
  ): Promise<boolean> {
    // Children may spend their own envelope plus unheld funds, never another
    // run's hold. A missing, zero or expired envelope grants no extra balance.
    const { available } = await readAvailable(new Date(), reservationId);
    return available >= estimatedCostMicros;
  }

  /** One page of the organization ledger, newest first. `hasMore` comes from reading
   *  one extra row — a `count(*)` would read every ledger row (#1881). */
  async function getTransactionHistory(
    opts: { limit?: number; offset?: number; type?: TransactionType } = {}
  ): Promise<{
    transactions: Array<{
      id: string;
      type: string;
      amount: number;
      balanceAfter: number;
      description: string | null;
      metadata: unknown;
      createdAt: Date;
    }>;
    hasMore: boolean;
  }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const rows = await db
      .select({
        id: transactions.id,
        type: transactions.type,
        amount: transactions.amount,
        balanceAfter: transactions.balanceAfter,
        description: transactions.description,
        metadata: transactions.metadata,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          opts.type ? eq(transactions.type, opts.type) : undefined
        )
      )
      // created_at is in seconds; the ULID id breaks ties so rows written in
      // the same second keep one order across pages.
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
      .limit(limit + 1)
      .offset(offset);

    return { transactions: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async function getBillingSettings(): Promise<OrganizationBillingSetting> {
    const [row] = await db
      .select()
      .from(organizationBillingSettings)
      .where(eq(organizationBillingSettings.organizationId, organizationId))
      .limit(1);

    if (row) return row;

    const [inserted] = await db
      .insert(organizationBillingSettings)
      .values({ organizationId })
      .onConflictDoNothing({
        target: organizationBillingSettings.organizationId,
      })
      .returning();

    if (inserted) return inserted;

    // Lost the race — peer inserted between our SELECT and INSERT.
    const [existing] = await db
      .select()
      .from(organizationBillingSettings)
      .where(eq(organizationBillingSettings.organizationId, organizationId))
      .limit(1);
    if (!existing) {
      throw new Error(
        `getBillingSettings: row missing for organization ${organizationId} after onConflictDoNothing`
      );
    }
    return existing;
  }

  return {
    getBalance,
    getAvailable,
    hasEnoughCredits,
    getTransactionHistory,
    getBillingSettings,
  };
}

/**
 * Full billing methods — extends read methods with writes that auto-inject userId.
 */
export function createBillingMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  const read = createBillingReadMethods(db, organizationId);

  async function emitOrganizationFunds(opts: {
    amountMicros: Microdollars;
    transactionId?: string;
    type?: TransactionType;
  }): Promise<void> {
    const snapshot = await read.getAvailable();
    await emitFundsUpdated({
      organizationId,
      ...snapshot,
      amountMicros: opts.amountMicros,
      transactionId: opts.transactionId,
      type: opts.type,
    });
  }

  async function clearAutoTopUpFailure(): Promise<void> {
    await db
      .update(organizationBillingSettings)
      .set({
        autoTopUpFailedAt: null,
        autoTopUpDeclineCode: null,
        updatedAt: new Date(),
      })
      .where(eq(organizationBillingSettings.organizationId, organizationId));
  }

  /**
   * Pause auto-reload after a decline, and tell the customer once (#1499).
   *
   * The `isNull` guard IS the one-shot claim: `maybeAutoTopUp` reaches here
   * from many reservation debits and captures, and only the transition
   * `autoTopUpFailedAt: null → now` notifies. `clearAutoTopUpFailure` (a
   * successful purchase, a new default card) re-arms the next send.
   */
  async function recordAutoTopUpFailure(declineCode: string): Promise<void> {
    const paused = {
      autoTopUpFailedAt: new Date(),
      autoTopUpDeclineCode: declineCode,
      updatedAt: new Date(),
    };
    const claimed = await db
      .update(organizationBillingSettings)
      .set(paused)
      .where(
        and(
          eq(organizationBillingSettings.organizationId, organizationId),
          isNull(organizationBillingSettings.autoTopUpFailedAt)
        )
      )
      .returning({
        organizationId: organizationBillingSettings.organizationId,
      });

    if (claimed.length === 0) {
      // Already paused. Refresh the cooldown window anyway — otherwise a
      // decline after the first cooldown expires would leave the stale
      // timestamp in place and the next debit would charge again (#1334).
      await db
        .update(organizationBillingSettings)
        .set(paused)
        .where(eq(organizationBillingSettings.organizationId, organizationId));
      return;
    }

    await emitOrganizationFunds({ amountMicros: ZERO_MICROS });

    try {
      const { available } = await read.getAvailable();
      await notifyAutoTopUpFailed({
        to: await createOrganizationManagementMethods(
          db,
          organizationId
        ).getOwnerEmail(),
        organizationId,
        userId,
        balanceMicros: available,
      });
    } catch (err) {
      // Log, don't rethrow and don't release the claim: clearing
      // `autoTopUpFailedAt` to retry the email would also lift the decline
      // cooldown, putting us straight back into the retry loop #1334 fixed.
      logger.error('Failed to send auto-top-up-failed email', {
        organizationId,
        err,
      });
    }
  }

  async function addCredits(
    amountMicros: Microdollars,
    opts: {
      type?: TransactionType;
      description?: string;
      metadata?: Record<string, unknown>;
      stripeSessionId?: string;
      /**
       * Makes the grant replay-safe. Without it (or `stripeSessionId`) the
       * `onConflictDoNothing` below has no reachable conflict target, so a
       * retried credit is applied twice.
       */
      idempotencyKey?: string;
      /** Who the ledger row names; defaults to the scoped user, null for a sweep. */
      userId?: string | null;
    } = {}
  ): Promise<{ newBalance: Microdollars; transactionId: string } | null> {
    if (amountMicros <= 0) {
      throw new ValidationError('Credit amount must be positive');
    }

    await db
      .insert(credits)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing();

    const [updated] = await db
      .update(credits)
      .set({
        balance: sql`${credits.balance} + ${amountMicros}`,
        updatedAt: new Date(),
      })
      .where(eq(credits.organizationId, organizationId))
      .returning({ balance: credits.balance });

    if (!updated) {
      throw new Error(
        `addCredits: update returned no row for organization ${organizationId}`
      );
    }

    const txType = opts.type ?? 'credit_purchase';

    const rows = await db
      .insert(transactions)
      .values({
        organizationId,
        userId: opts.userId === undefined ? userId : opts.userId,
        type: txType,
        amount: amountMicros,
        balanceAfter: updated.balance,
        description:
          opts.description ??
          `Added ${microsToDisplayUsd(amountMicros)} credits`,
        metadata: opts.metadata ?? {},
        stripeSessionId: opts.stripeSessionId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    if (rows.length === 0) {
      await db
        .update(credits)
        .set({
          balance: sql`${credits.balance} - ${amountMicros}`,
          updatedAt: new Date(),
        })
        .where(eq(credits.organizationId, organizationId));
      return null;
    }

    const insertedRow = rows[0];
    if (!insertedRow) {
      throw new Error(
        `addCredits: transaction insert returned no row for organization ${organizationId}`
      );
    }
    const transactionId = insertedRow.id;

    await db.insert(creditBatches).values({
      organizationId,
      originalAmount: amountMicros,
      remainingAmount: amountMicros,
      source: mapBatchSource(txType, opts.metadata),
      transactionId,
      expiresAt: calculateExpiryDate(),
    });

    const newBalance = micros(updated.balance);
    await emitOrganizationFunds({
      amountMicros,
      transactionId,
      type: txType,
    });

    // A successful card charge (checkout, saved-card purchase, or
    // auto-top-up) is the signal that the payment method works again.
    if (txType === 'credit_purchase') {
      await clearAutoTopUpFailure();
    }

    return { newBalance, transactionId };
  }

  async function saveStripeCustomerId(stripeCustomerId: string): Promise<void> {
    await db
      .insert(organizationBillingSettings)
      .values({ organizationId, stripeCustomerId })
      .onConflictDoUpdate({
        target: organizationBillingSettings.organizationId,
        set: {
          stripeCustomerId,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Charges provider cost at face value (no usage fee). Triggers auto-top-up
   * if available funds (posted minus open holds) drop to the threshold.
   *
   * Pass `opts.idempotencyKey` (convention: `${workflowInstanceId}:<charge-name>`)
   * from any retryable context — a workflow `step.do` that throws partway
   * re-runs its closure, and without the key every replay double-debits the
   * organization and writes a duplicate ledger row. The balance UPDATE and the
   * transaction INSERT run in one atomic `db.batch`; the UPDATE is guarded on
   * "no transaction with this key exists yet" and the INSERT dedupes via the
   * partial unique index on `(team_id, idempotency_key)`. A replay is a no-op
   * that returns the original transaction id — note that on a replay the
   * returned `chargedAmount` is what the ORIGINAL attempt charged; nothing
   * was debited by this call (don't emit "charged $X" side effects from it).
   */
  async function deductCredits(
    rawCostMicros: Microdollars,
    opts: {
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {}
  ): Promise<{
    newBalance: Microdollars;
    chargedAmount: Microdollars;
    transactionId: string;
  }> {
    if (rawCostMicros <= 0)
      return {
        newBalance: await read.getBalance(),
        chargedAmount: ZERO_MICROS,
        transactionId: '',
      };

    const chargedAmount = rawCostMicros;
    const { idempotencyKey } = opts;

    await db
      .insert(credits)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing();

    const chargedUsd = microsToUsd(chargedAmount);

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} - ${chargedAmount}`,
        updatedAt: new Date(),
      })
      .where(
        idempotencyKey
          ? and(
              eq(credits.organizationId, organizationId),
              notExists(
                db
                  .select({ id: transactions.id })
                  .from(transactions)
                  .where(
                    and(
                      eq(transactions.organizationId, organizationId),
                      eq(transactions.idempotencyKey, idempotencyKey)
                    )
                  )
              )
            )
          : eq(credits.organizationId, organizationId)
      );

    // balanceAfter reads the post-UPDATE balance via subquery — the batch
    // statements run sequentially inside one transaction, so this sees the
    // decremented value. On a replay the INSERT no-ops, so the (stale) value
    // is never written.
    const insertTransaction = db
      .insert(transactions)
      .values({
        organizationId,
        userId,
        type: 'credit_usage' as TransactionType,
        amount: negateMicros(chargedAmount),
        balanceAfter: sql`(select ${credits.balance} from ${credits} where ${credits.organizationId} = ${organizationId})`,
        description: opts.description ?? `Usage: $${chargedUsd.toFixed(4)}`,
        metadata: {
          costMicros: chargedAmount,
          ...opts.metadata,
        },
        idempotencyKey: idempotencyKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    // Third statement: re-read the balance to return to the caller. Distinct
    // from the `balanceAfter` ledger column above (that one is persisted into
    // the transaction row; this one is the authoritative read-back, correct
    // even on a replay where the UPDATE no-ops) — both rely on running after
    // `updateBalance` inside the same batch transaction, so don't "optimize"
    // either away in favor of the other.
    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId));

    const [, insertedRows, balanceRows] = await db.batch([
      updateBalance,
      insertTransaction,
      readBackBalance,
    ]);

    const balanceRow = balanceRows[0];
    if (!balanceRow) {
      throw new Error(
        `deductCredits: credits row missing for organization ${organizationId} after batch`
      );
    }
    const newBalance = micros(balanceRow.balance);

    let transactionId = insertedRows[0]?.id;
    // True only when this call wrote the ledger row — not an idempotent replay.
    // Don't fire "charged $X" side effects (realtime) on replay.
    const isNewCharge = Boolean(transactionId);
    if (!transactionId) {
      if (!idempotencyKey) {
        throw new Error(
          `deductCredits: transaction insert returned no row for organization ${organizationId}`
        );
      }
      // Replay of an already-applied deduction — recover the original
      // transaction id. Must not throw: the charge landed on a prior attempt.
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, organizationId),
            eq(transactions.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          `deductCredits: no transaction row for organization ${organizationId} key ${idempotencyKey} after conflict no-op`
        );
      }
      transactionId = existing.id;
    }

    if (isNewCharge) {
      await emitOrganizationFunds({
        amountMicros: negateMicros(chargedAmount),
        transactionId,
        type: 'credit_usage',
      });
    }

    void maybeAutoTopUp().catch((err) => {
      logger.error('Auto top-up failed after deduction', {
        organizationId,
        balanceMicros: newBalance,
        err,
      });
    });

    return {
      newBalance,
      chargedAmount,
      transactionId,
    };
  }

  async function getTransactionByIdempotencyKey(idempotencyKey: string) {
    const [row] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          eq(transactions.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomic conditional debit: `UPDATE credits SET balance = balance - n
   * WHERE balance >= n` plus a ledger row, in one `db.batch`. The INSERT
   * only lands when the UPDATE actually changed a row (`changes() > 0`),
   * so an overdraft is a no-op rather than a CHECK failure or a phantom
   * charge. Replay of the same `idempotencyKey` recovers the original row.
   */
  async function tryDebit(
    amountMicros: Microdollars,
    opts: {
      description: string;
      metadata: Record<string, unknown>;
      idempotencyKey: string;
      type?: TransactionType;
    }
  ): Promise<TryDebitResult> {
    if (amountMicros <= 0) return { ok: false };

    const existing = await getTransactionByIdempotencyKey(opts.idempotencyKey);
    if (existing) {
      const [balanceRow] = await db
        .select({ balance: credits.balance })
        .from(credits)
        .where(eq(credits.organizationId, organizationId))
        .limit(1);
      return {
        ok: true,
        replay: true,
        transactionId: existing.id,
        chargedAmount: micros(Math.abs(existing.amount)),
        newBalance: micros(balanceRow?.balance ?? 0),
      };
    }

    await db
      .insert(credits)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing();

    const txId = generateId();
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const txType = opts.type ?? 'credit_usage';
    const signedAmount =
      txType === 'credit_usage' ? negateMicros(amountMicros) : amountMicros;

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} - ${amountMicros}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(credits.organizationId, organizationId),
          gte(credits.balance, amountMicros),
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.organizationId, organizationId),
                  eq(transactions.idempotencyKey, opts.idempotencyKey)
                )
              )
          )
        )
      );

    const insertTransaction = db
      .insert(transactions)
      .select(
        db
          .select({
            id: sql<string>`${txId}`.as('id'),
            organizationId: sql<string>`${organizationId}`.as(
              'organization_id'
            ),
            userId: sql<string>`${userId}`.as('user_id'),
            type: sql<string>`${txType}`.as('type'),
            amount: sql<number>`${signedAmount}`.as('amount'),
            balanceAfter: credits.balance,
            description: sql<string>`${opts.description}`.as('description'),
            metadata: sql`${JSON.stringify(opts.metadata)}`.as('metadata'),
            idempotencyKey: sql<string>`${opts.idempotencyKey}`.as(
              'idempotency_key'
            ),
            createdAt: sql`${nowSeconds}`.as('created_at'),
          })
          .from(credits)
          .where(
            and(eq(credits.organizationId, organizationId), sql`changes() > 0`)
          )
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId));

    const [, insertedRows, balanceRows] = await db.batch([
      updateBalance,
      insertTransaction,
      readBackBalance,
    ]);

    const balanceRow = balanceRows[0];
    if (!balanceRow) {
      throw new Error(
        `tryDebit: credits row missing for organization ${organizationId} after batch`
      );
    }
    const newBalance = micros(balanceRow.balance);
    const transactionId = insertedRows[0]?.id;
    if (!transactionId) {
      const raced = await getTransactionByIdempotencyKey(opts.idempotencyKey);
      if (raced) {
        return {
          ok: true,
          replay: true,
          transactionId: raced.id,
          chargedAmount: micros(Math.abs(raced.amount)),
          newBalance,
        };
      }
      return { ok: false };
    }

    await emitOrganizationFunds({
      amountMicros: signedAmount,
      transactionId,
      type: txType,
    });

    if (txType === 'credit_usage') {
      void maybeAutoTopUp().catch((err) => {
        logger.error('Auto top-up failed after reservation debit', {
          organizationId,
          balanceMicros: newBalance,
          err,
        });
      });
    }

    return {
      ok: true,
      replay: false,
      transactionId,
      chargedAmount: amountMicros,
      newBalance,
    };
  }

  async function tryDeductCredits(
    amountMicros: Microdollars,
    opts: {
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<TryDebitResult> {
    return tryDebit(amountMicros, {
      description:
        opts.description ?? `Usage: $${microsToUsd(amountMicros).toFixed(4)}`,
      metadata: opts.metadata ?? {},
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /**
   * Hold `amountMicros` if the balance covers it after every live hold. With
   * `spendCap`, the same statement also requires a live grant of (client,
   * this user, this organization) whose cap covers this month's settled
   * lines, the client's live holds and this hold (model-gateway.md § The cap).
   */
  async function createReservation(
    amountMicros: Microdollars,
    opts: {
      idempotencyKey: string;
      sequenceId?: string;
      ttlMs?: number;
      spendCap?: { oauthClientId: string; appId: string | null };
    }
  ): Promise<CreateReservationResult> {
    if (amountMicros <= 0) return { ok: false };

    const existing = await db
      .select()
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.organizationId, organizationId),
          eq(creditReservations.idempotencyKey, opts.idempotencyKey)
        )
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow) {
      return {
        ok: true,
        reservationId: existingRow.id,
        remaining: micros(existingRow.remainingAmount),
        replay: true,
      };
    }

    await db
      .insert(credits)
      .values({ organizationId, balance: 0 })
      .onConflictDoNothing();

    const reservationId = generateId();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (opts.ttlMs ?? RESERVATION_TTL_MS)
    );
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expiresSeconds = Math.floor(expiresAt.getTime() / 1000);
    const { spendCap } = opts;
    const capGuard = spendCap
      ? fitsUnderCapSql(
          spendCapScope(organizationId, spendCap.oauthClientId, now),
          userId,
          amountMicros
        )
      : undefined;

    const inserted = await db
      .insert(creditReservations)
      .select(
        db
          .select({
            id: sql<string>`${reservationId}`.as('id'),
            organizationId: sql<string>`${organizationId}`.as(
              'organization_id'
            ),
            userId: sql<string>`${userId}`.as('user_id'),
            sequenceId: sql`${opts.sequenceId ?? null}`.as('sequence_id'),
            originalAmount: sql<number>`${amountMicros}`.as('original_amount'),
            remainingAmount: sql<number>`${amountMicros}`.as(
              'remaining_amount'
            ),
            expiresAt: sql`${expiresSeconds}`.as('expires_at'),
            idempotencyKey: sql<string>`${opts.idempotencyKey}`.as(
              'idempotency_key'
            ),
            createdAt: sql`${nowSeconds}`.as('created_at'),
            oauthClientId: sql`${spendCap?.oauthClientId ?? null}`.as(
              'oauth_client_id'
            ),
            appId: sql`${spendCap?.appId ?? null}`.as('app_id'),
          })
          .from(credits)
          .where(
            and(
              eq(credits.organizationId, organizationId),
              sql`${credits.balance} - coalesce((
                select sum(${creditReservations.remainingAmount})
                from ${creditReservations}
                where ${creditReservations.organizationId} = ${organizationId}
                  and ${creditReservations.remainingAmount} > 0
                  and ${creditReservations.expiresAt} > ${nowSeconds}
              ), 0) >= ${amountMicros}`,
              capGuard
            )
          )
      )
      .onConflictDoNothing()
      .returning({ id: creditReservations.id });

    const created = inserted[0];
    if (!created) {
      const raced = await db
        .select()
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.organizationId, organizationId),
            eq(creditReservations.idempotencyKey, opts.idempotencyKey)
          )
        )
        .limit(1);
      const racedRow = raced[0];
      if (racedRow) {
        return {
          ok: true,
          reservationId: racedRow.id,
          remaining: micros(racedRow.remainingAmount),
          replay: true,
        };
      }
      return { ok: false };
    }

    await emitOrganizationFunds({ amountMicros: ZERO_MICROS });
    return {
      ok: true,
      reservationId: created.id,
      remaining: amountMicros,
      replay: false,
    };
  }

  async function growReservation(
    reservationId: string,
    extraMicros: Microdollars,
    opts: { ttlMs?: number } = {}
  ): Promise<GrowReservationResult> {
    if (extraMicros <= 0) {
      const [row] = await db
        .select({ remaining: creditReservations.remainingAmount })
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.id, reservationId),
            eq(creditReservations.organizationId, organizationId)
          )
        )
        .limit(1);
      return row
        ? { ok: true, remaining: micros(row.remaining) }
        : { ok: false };
    }

    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date(
      now.getTime() + (opts.ttlMs ?? RESERVATION_TTL_MS)
    );

    const [updated] = await db
      .update(creditReservations)
      .set({
        remainingAmount: sql`${creditReservations.remainingAmount} + ${extraMicros}`,
        originalAmount: sql`${creditReservations.originalAmount} + ${extraMicros}`,
        expiresAt,
      })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.organizationId, organizationId),
          sql`${extraMicros} <= (
            (select ${credits.balance} from ${credits} where ${credits.organizationId} = ${organizationId})
            - coalesce((
              select sum(${creditReservations.remainingAmount})
              from ${creditReservations}
              where ${creditReservations.organizationId} = ${organizationId}
                and ${creditReservations.remainingAmount} > 0
                and ${creditReservations.expiresAt} > ${nowSeconds}
            ), 0)
          )`
        )
      )
      .returning({ remaining: creditReservations.remainingAmount });

    if (!updated) return { ok: false };
    await emitOrganizationFunds({ amountMicros: ZERO_MICROS });
    return { ok: true, remaining: micros(updated.remaining) };
  }

  /**
   * The one capture: grow the hold if the balance covers the extra, debit
   * `min(remaining, actual)`, write the `credit_usage` row, shrink the hold,
   * then `afterDebit` statements keyed on the new transaction id, all in one
   * batch. `transactionId` is null when nothing was debited.
   */
  async function capture(
    reservationId: string,
    actualMicros: Microdollars,
    opts: {
      idempotencyKey: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
    afterDebit?: (
      transactionId: string,
      nowSeconds: number
    ) => BatchItem<'sqlite'>[]
  ): Promise<
    | { ok: false; reason: 'missing' }
    | {
        ok: true;
        captured: Microdollars;
        skippedDeltaMicros?: Microdollars;
        transactionId: string | null;
        replay: boolean;
      }
  > {
    // Replay before grow — a retried over-actual capture must not inflate
    // remaining a second time.
    const already = await getTransactionByIdempotencyKey(opts.idempotencyKey);
    if (already) {
      const captured = micros(Math.abs(already.amount));
      return {
        ok: true,
        captured,
        skippedDeltaMicros: skippedCaptureDelta(actualMicros, captured),
        transactionId: already.id,
        replay: true,
      };
    }

    const [reservation] = await db
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.organizationId, organizationId)
        )
      )
      .limit(1);
    if (!reservation) return { ok: false, reason: 'missing' };

    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
    const txId = generateId();
    const txType: TransactionType = 'credit_usage';
    const description =
      opts.description ?? `Usage: $${microsToUsd(actualMicros).toFixed(4)}`;
    const metadataJson = JSON.stringify({
      reservationId,
      ...opts.metadata,
    });

    // Take is computed in SQL at debit time so two captures racing the
    // same envelope split remaining instead of one silent-zeroing.
    const takeExpr = sql`(
      select min(${creditReservations.remainingAmount}, ${actualMicros})
      from ${creditReservations}
      where ${creditReservations.id} = ${reservationId}
        and ${creditReservations.organizationId} = ${organizationId}
    )`;
    const extraExpr = sql`max(0, ${actualMicros} - ${creditReservations.remainingAmount})`;

    const growHold = db
      .update(creditReservations)
      .set({
        remainingAmount: sql`${creditReservations.remainingAmount} + ${extraExpr}`,
        originalAmount: sql`${creditReservations.originalAmount} + ${extraExpr}`,
        expiresAt,
      })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.organizationId, organizationId),
          sql`${extraExpr} > 0`,
          sql`${extraExpr} <= (
            (select ${credits.balance} from ${credits} where ${credits.organizationId} = ${organizationId})
            - coalesce((
              select sum(${creditReservations.remainingAmount})
              from ${creditReservations}
              where ${creditReservations.organizationId} = ${organizationId}
                and ${creditReservations.remainingAmount} > 0
                and ${creditReservations.expiresAt} > ${nowSeconds}
            ), 0)
          )`
        )
      );

    const updateBalance = db
      .update(credits)
      .set({
        balance: sql`${credits.balance} - ${takeExpr}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(credits.organizationId, organizationId),
          sql`${takeExpr} > 0`,
          sql`${credits.balance} >= ${takeExpr}`,
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.organizationId, organizationId),
                  eq(transactions.idempotencyKey, opts.idempotencyKey)
                )
              )
          )
        )
      );

    const insertTransaction = db
      .insert(transactions)
      .select(
        db
          .select({
            id: sql<string>`${txId}`.as('id'),
            organizationId: sql<string>`${organizationId}`.as(
              'organization_id'
            ),
            userId: sql<string>`${userId}`.as('user_id'),
            type: sql<string>`${txType}`.as('type'),
            amount: sql<number>`(${takeExpr}) * -1`.as('amount'),
            balanceAfter: credits.balance,
            description: sql<string>`${description}`.as('description'),
            metadata: sql`${metadataJson}`.as('metadata'),
            idempotencyKey: sql<string>`${opts.idempotencyKey}`.as(
              'idempotency_key'
            ),
            createdAt: sql`${nowSeconds}`.as('created_at'),
          })
          .from(credits)
          .where(
            and(eq(credits.organizationId, organizationId), sql`changes() > 0`)
          )
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id, amount: transactions.amount });

    // `changes()` here reads the transaction insert, so it must stay right after it.
    const reduceRemaining = db
      .update(creditReservations)
      .set({
        remainingAmount: sql`${creditReservations.remainingAmount} - min(${creditReservations.remainingAmount}, ${actualMicros})`,
      })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.organizationId, organizationId),
          sql`changes() > 0`
        )
      );

    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId));

    const [, , insertedRows, , balanceRows] = await db.batch([
      growHold,
      updateBalance,
      insertTransaction,
      reduceRemaining,
      readBackBalance,
      ...(afterDebit?.(txId, nowSeconds) ?? []),
    ]);

    const inserted = insertedRows[0];
    if (!inserted) {
      const raced = await getTransactionByIdempotencyKey(opts.idempotencyKey);
      if (raced) {
        const captured = micros(Math.abs(raced.amount));
        return {
          ok: true,
          captured,
          skippedDeltaMicros: skippedCaptureDelta(actualMicros, captured),
          transactionId: raced.id,
          replay: true,
        };
      }
      return {
        ok: true,
        captured: ZERO_MICROS,
        skippedDeltaMicros: skippedCaptureDelta(actualMicros, ZERO_MICROS),
        transactionId: null,
        replay: false,
      };
    }

    const captured = micros(Math.abs(inserted.amount));
    const balanceRow = balanceRows[0];
    const newBalance = micros(balanceRow?.balance ?? 0);

    await emitOrganizationFunds({
      amountMicros: negateMicros(captured),
      transactionId: inserted.id,
      type: txType,
    });

    void maybeAutoTopUp().catch((err) => {
      logger.error('Auto top-up failed after reservation capture', {
        organizationId,
        balanceMicros: newBalance,
        err,
      });
    });

    return {
      ok: true,
      captured,
      skippedDeltaMicros: skippedCaptureDelta(actualMicros, captured),
      transactionId: inserted.id,
      replay: false,
    };
  }

  async function captureReservation(
    reservationId: string,
    actualMicros: Microdollars,
    opts: {
      idempotencyKey: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<CaptureReservationResult> {
    if (actualMicros <= 0) {
      return { ok: true, captured: ZERO_MICROS };
    }
    const result = await capture(reservationId, actualMicros, opts);
    if (!result.ok) return result;
    const { captured, skippedDeltaMicros } = result;
    return skippedDeltaMicros
      ? { ok: true, captured, skippedDeltaMicros }
      : { ok: true, captured };
  }

  async function listChargeLinesOfTransaction(
    transactionId: string
  ): Promise<SettledChargeLine[]> {
    const rows = await db
      .select({
        id: chargeLines.id,
        kind: chargeLines.kind,
        amountMicros: chargeLines.amountMicros,
        payeeOrganizationId: chargeLines.payeeOrganizationId,
        sku: chargeLines.sku,
      })
      .from(chargeLines)
      .where(
        and(
          eq(chargeLines.organizationId, organizationId),
          eq(chargeLines.transactionId, transactionId)
        )
      );
    return inFillOrder(
      rows.map((row) => ({ ...row, amountMicros: micros(row.amountMicros) }))
    );
  }

  /**
   * Capture a reservation for a charge made of lines: the debit, its
   * `credit_usage` row and its lines in one batch. Lines are written only
   * when the debit is, and always sum to it: a short capture fills them in
   * `inFillOrder`, so payee lines are cut first and the provider cost last.
   * Each payee line writes its pending earning in the same batch, at the
   * line's written amount. A replay of the key writes nothing and returns
   * the original lines.
   */
  async function settleReservation(
    reservationId: string,
    lines: readonly ChargeLineInput[],
    opts: {
      idempotencyKey: string;
      description?: string;
      metadata?: Record<string, unknown>;
      attribution?: ChargeLineAttribution;
    }
  ): Promise<SettleReservationResult> {
    for (const line of lines) {
      if (!Number.isSafeInteger(line.amountMicros) || line.amountMicros < 0) {
        throw new ValidationError(
          `Charge line ${line.kind} must be a non-negative integer`
        );
      }
    }
    const ordered = inFillOrder(lines.filter((line) => line.amountMicros > 0));
    const total = micros(
      ordered.reduce((sum, line) => sum + line.amountMicros, 0)
    );
    if (!Number.isSafeInteger(total)) {
      throw new ValidationError('Charge lines must sum to a safe integer');
    }
    if (total <= 0) {
      return {
        ok: true,
        captured: ZERO_MICROS,
        transactionId: null,
        lines: [],
        replay: false,
      };
    }

    const attribution = opts.attribution ?? {};
    if (
      ordered.some((line) => line.payeeOrganizationId) &&
      !attribution.appId
    ) {
      throw new ValidationError('A payee line needs the app it is earned by');
    }
    const result = await capture(
      reservationId,
      total,
      opts,
      (transactionId, nowSeconds) => {
        let before = 0;
        return ordered.flatMap((line) => {
          const prefix = before;
          before += line.amountMicros;
          const lineId = generateId();
          // What is left of the debit after the lines ahead of this one, capped at this line.
          const left = sql`(-${transactions.amount} - ${prefix})`;
          const insertLine = db.insert(chargeLines).select(
            db
              .select({
                id: sql<string>`${lineId}`.as('id'),
                organizationId: sql<string>`${organizationId}`.as(
                  'organization_id'
                ),
                transactionId: transactions.id,
                kind: sql<string>`${line.kind}`.as('kind'),
                amountMicros:
                  sql<number>`min(${line.amountMicros}, ${left})`.as(
                    'amount_micros'
                  ),
                payeeOrganizationId:
                  sql`${line.payeeOrganizationId ?? null}`.as(
                    'payee_organization_id'
                  ),
                gatewayJobId: sql`${attribution.gatewayJobId ?? null}`.as(
                  'gateway_job_id'
                ),
                oauthClientId: sql`${attribution.oauthClientId ?? null}`.as(
                  'oauth_client_id'
                ),
                appId: sql`${attribution.appId ?? null}`.as('app_id'),
                sku: sql`${line.sku ?? null}`.as('sku'),
                createdAt: sql`${nowSeconds}`.as('created_at'),
              })
              .from(transactions)
              .where(
                and(
                  eq(transactions.id, transactionId),
                  eq(transactions.organizationId, organizationId),
                  sql`${left} > 0`
                )
              )
          );
          if (!line.payeeOrganizationId) return [insertLine];
          // The earning reads the line this batch just wrote, so it exists iff the line does, at its amount.
          const insertEarning = db.insert(gatewayEarnings).select(
            db
              .select({
                id: sql<string>`${generateId()}`.as('id'),
                chargeLineId: chargeLines.id,
                payerOrganizationId: chargeLines.organizationId,
                payeeOrganizationId:
                  sql<string>`${line.payeeOrganizationId}`.as(
                    'payee_organization_id'
                  ),
                appId: sql<string>`${attribution.appId ?? null}`.as('app_id'),
                amountMicros: chargeLines.amountMicros,
                status: sql<string>`'pending'`.as('status'),
                availableAt: sql`${nowSeconds + EARNING_HOLD_DAYS * 86_400}`.as(
                  'available_at'
                ),
                maturedAt: sql`null`.as('matured_at'),
                transactionId: sql`null`.as('transaction_id'),
                cancelledAt: sql`null`.as('cancelled_at'),
                createdAt: sql`${nowSeconds}`.as('created_at'),
              })
              .from(chargeLines)
              .where(
                and(
                  eq(chargeLines.id, lineId),
                  eq(chargeLines.organizationId, organizationId)
                )
              )
          );
          return [insertLine, insertEarning];
        });
      }
    );
    if (!result.ok) return result;
    return {
      ok: true,
      captured: result.captured,
      ...(result.skippedDeltaMicros && {
        skippedDeltaMicros: result.skippedDeltaMicros,
      }),
      transactionId: result.transactionId,
      lines: result.transactionId
        ? await listChargeLinesOfTransaction(result.transactionId)
        : [],
      replay: result.replay,
    };
  }

  /** A charge `settleReservation` already debited under this key, with its lines; null when none. */
  async function getSettledCharge(idempotencyKey: string): Promise<{
    transactionId: string;
    captured: Microdollars;
    createdAt: Date;
    lines: SettledChargeLine[];
  } | null> {
    const row = await getTransactionByIdempotencyKey(idempotencyKey);
    if (!row) return null;
    return {
      transactionId: row.id,
      captured: micros(Math.abs(row.amount)),
      createdAt: row.createdAt,
      lines: await listChargeLinesOfTransaction(row.id),
    };
  }

  async function zeroReservation(reservationId: string): Promise<void> {
    await db
      .update(creditReservations)
      .set({ remainingAmount: 0 })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.organizationId, organizationId)
        )
      );
    await emitOrganizationFunds({ amountMicros: ZERO_MICROS });
  }

  async function updateAutoTopUpSettings(settings: {
    enabled: boolean;
    thresholdMicros?: Microdollars;
    amountMicros?: Microdollars;
  }): Promise<void> {
    if (
      settings.amountMicros !== undefined &&
      settings.amountMicros < MIN_TOPUP_AMOUNT_MICROS
    ) {
      throw new ValidationError(
        `Auto top-up amount must be at least ${microsToDisplayUsd(MIN_TOPUP_AMOUNT_MICROS)}`
      );
    }

    if (
      settings.enabled &&
      settings.thresholdMicros !== undefined &&
      settings.amountMicros !== undefined &&
      settings.amountMicros <= settings.thresholdMicros
    ) {
      throw new ValidationError(
        'Auto top-up amount must be greater than the threshold'
      );
    }

    await db
      .insert(organizationBillingSettings)
      .values({
        organizationId,
        autoTopUpEnabled: settings.enabled,
        autoTopUpThresholdMicros: settings.thresholdMicros,
        autoTopUpAmountMicros: settings.amountMicros,
        autoTopUpFailedAt: null,
        autoTopUpDeclineCode: null,
      })
      .onConflictDoUpdate({
        target: organizationBillingSettings.organizationId,
        set: {
          autoTopUpEnabled: settings.enabled,
          ...(settings.thresholdMicros !== undefined && {
            autoTopUpThresholdMicros: settings.thresholdMicros,
          }),
          ...(settings.amountMicros !== undefined && {
            autoTopUpAmountMicros: settings.amountMicros,
          }),
          autoTopUpFailedAt: null,
          autoTopUpDeclineCode: null,
          updatedAt: new Date(),
        },
      });
  }

  async function maybeAutoTopUp(): Promise<void> {
    if (!isStripeEnabled()) return;

    const settings = await read.getBillingSettings();

    // `== null`, not falsy: a threshold of 0 ("top up when I hit zero") is a
    // legitimate setting, and treating it as "unset" would silently disable
    // auto-top-up for an organization whose settings page says it is on.
    if (
      !settings.autoTopUpEnabled ||
      !settings.stripeCustomerId ||
      settings.autoTopUpThresholdMicros == null ||
      settings.autoTopUpAmountMicros == null
    ) {
      return;
    }

    // Holds reduce spendable funds; posted balance can sit above the
    // threshold while the pill shows available below it.
    const { available } = await read.getAvailable();
    if (available > settings.autoTopUpThresholdMicros) {
      return;
    }

    if (
      settings.autoTopUpFailedAt &&
      Date.now() - settings.autoTopUpFailedAt.getTime() <
        AUTO_TOPUP_DECLINE_COOLDOWN_MS
    ) {
      logger.debug('Auto top-up skipped: decline cooldown', {
        organizationId,
        declineCode: settings.autoTopUpDeclineCode,
        failedAt: settings.autoTopUpFailedAt,
      });
      return;
    }

    const [recentAutoTopUp] = await db
      .select({ createdAt: transactions.createdAt })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          sql`json_extract(${transactions.metadata}, '$.autoTopUp') = true`
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);

    if (recentAutoTopUp) {
      const elapsed = Date.now() - recentAutoTopUp.createdAt.getTime();
      if (elapsed < AUTO_TOPUP_COOLDOWN_MS) {
        logger.info(
          `Cooldown active for organization ${organizationId}, skipping (${Math.round(elapsed / 1000)}s ago)`
        );
        return;
      }
    }

    const topUpMicros = micros(settings.autoTopUpAmountMicros);

    // Dynamic import: this module is in the client module graph (via
    // middleware → scoped), and a static `stripe` import ships the Stripe
    // Node SDK to the browser (#1253). Only the server ever runs this path.
    const { getStripeOrThrow } = await import('@/billing/server/stripe');
    const stripe = getStripeOrThrow();
    const amountCents = totalCheckoutCents(topUpMicros);

    // Every exit below leaves auto-top-up silently dead for this organization while
    // the settings page still advertises it as on — so each one logs (#1099).
    const customer = await stripe.customers.retrieve(settings.stripeCustomerId);
    if (customer.deleted) {
      logger.warn('Auto top-up skipped: Stripe customer deleted', {
        organizationId,
        stripeCustomerId: settings.stripeCustomerId,
      });
      return;
    }

    const defaultPaymentMethod =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      customer.invoice_settings?.default_payment_method;
    if (!defaultPaymentMethod) {
      logger.warn('Auto top-up skipped: no default payment method', {
        organizationId,
        stripeCustomerId: settings.stripeCustomerId,
      });
      return;
    }

    const paymentMethodId =
      typeof defaultPaymentMethod === 'string'
        ? defaultPaymentMethod
        : defaultPaymentMethod.id;

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: settings.stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        expand: ['latest_charge'],
        // userId is required by stripeWebhookMiddleware — without it every
        // payment_intent.* webhook for this charge is rejected with a 400.
        metadata: {
          organizationId,
          userId,
          type: 'auto_top_up',
        },
      });
    } catch (err) {
      const declineCode = stripeDeclineCode(err);
      if (declineCode) {
        logger.error('Auto top-up declined', {
          organizationId,
          declineCode,
          amountCents,
        });
        await recordAutoTopUpFailure(declineCode);
        return;
      }
      throw err;
    }

    if (paymentIntent.status !== 'succeeded') {
      // Declines and SCA (`requires_action`) are the common off-session
      // outcomes. Record a cooldown so the next debit/capture does not
      // fire another PaymentIntent at the same card (#1334).
      logger.error('Auto top-up payment did not succeed', {
        organizationId,
        status: paymentIntent.status,
        amountCents,
        stripePaymentIntentId: paymentIntent.id,
      });
      await recordAutoTopUpFailure(paymentIntent.status);
      return;
    }

    const charge = paymentIntent.latest_charge;
    const receiptUrl =
      charge && typeof charge === 'object' ? charge.receipt_url : undefined;

    await addCredits(topUpMicros, {
      description: `Auto top-up: ${microsToDisplayUsd(topUpMicros)}`,
      metadata: {
        stripePaymentIntentId: paymentIntent.id,
        autoTopUp: true,
        ...(receiptUrl && { receiptUrl }),
      },
    });
  }

  async function checkAutoTopUp(): Promise<void> {
    await maybeAutoTopUp();
  }

  /** Sum active (non-expired) batch remainingAmounts and compare to credits.balance */
  async function reconcileBatchBalance(): Promise<{
    runningBalance: Microdollars;
    batchTotal: Microdollars;
    drift: number;
  }> {
    const [balanceRow] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId))
      .limit(1);

    const runningBalance = micros(balanceRow?.balance ?? 0);

    const [batchRow] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${creditBatches.remainingAmount}), 0)`,
      })
      .from(creditBatches)
      .where(eq(creditBatches.organizationId, organizationId));

    const batchTotal = micros(batchRow?.total ?? 0);

    return {
      runningBalance,
      batchTotal,
      drift: runningBalance - batchTotal,
    };
  }

  /**
   * Redeem a gift token for an organization. Adds credits via the billing sub-module.
   * Caller must provide an addCredits function (from billing sub-module) to avoid
   * circular dependency.
   *
   * Known refusals return `{ status: 'refused' }` (#2033). A code this organization
   * already holds is "already redeemed" / "once per account" even when the
   * cap is also full — that check comes before the cap, so a single-use code
   * the caller used does not come back as "fully redeemed".
   */
  // The cap pre-check must not read a replica (#2233); the unique index closes the rest.
  const redeemGiftToken = (opts: Parameters<typeof redeemOnPrimary>[0]) =>
    onPrimary(() => redeemOnPrimary(opts));

  async function redeemOnPrimary(opts: {
    code: string;
    organizationId: string;
    userId: string;
    addCredits: (
      amountMicros: Microdollars,
      creditOpts: {
        type?: TransactionType;
        description?: string;
        metadata?: Record<string, unknown>;
      }
    ) => Promise<{ newBalance: Microdollars; transactionId: string } | null>;
  }): Promise<GiftRedeemResult> {
    const normalizedCode = normalizeGiftCode(opts.code);

    const [token] = await db
      .select()
      .from(giftTokens)
      .where(eq(giftTokens.code, normalizedCode))
      .limit(1);

    if (!token) {
      return { status: 'refused', reason: 'invalid' };
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      return { status: 'refused', reason: 'expired' };
    }

    const organizationRedemption = async () => {
      const [holder] = await db
        .select({ userId: giftTokenRedemptions.userId })
        .from(giftTokenRedemptions)
        .where(
          and(
            eq(giftTokenRedemptions.giftTokenId, token.id),
            eq(giftTokenRedemptions.organizationId, opts.organizationId)
          )
        )
        .limit(1);
      return holder ?? null;
    };

    const ownRedemption = await organizationRedemption();
    if (ownRedemption) {
      return {
        status: 'refused',
        reason: giftRedeemHolderReason(ownRedemption.userId, opts.userId),
      };
    }

    const [redemptionRow] = await db
      .select({ value: count() })
      .from(giftTokenRedemptions)
      .where(eq(giftTokenRedemptions.giftTokenId, token.id));

    const redemptionCount = redemptionRow?.value ?? 0;

    if (redemptionCount >= token.maxRedemptions) {
      return { status: 'refused', reason: 'fully_redeemed' };
    }

    // Unique index on (giftTokenId, organizationId) closes the race the pre-check missed.
    const [inserted] = await db
      .insert(giftTokenRedemptions)
      .values({
        id: generateId(),
        giftTokenId: token.id,
        organizationId: opts.organizationId,
        userId: opts.userId,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      const holder = await organizationRedemption();
      return {
        status: 'refused',
        reason: holder
          ? giftRedeemHolderReason(holder.userId, opts.userId)
          : 'already_redeemed',
      };
    }

    const amountMicros = micros(token.amountMicros);

    const result = await opts.addCredits(amountMicros, {
      type: 'credit_adjustment',
      description: `Gift code redeemed: ${normalizedCode} (${microsToDisplayUsd(amountMicros)})`,
      metadata: { giftTokenId: token.id, giftCode: normalizedCode },
    });

    return {
      status: 'redeemed',
      newBalance: result ? microsToUsd(result.newBalance) : 0,
      amountUsd: microsToUsd(amountMicros),
    };
  }
  return {
    ...read,
    addCredits,
    saveStripeCustomerId,
    clearAutoTopUpFailure,
    deductCredits,
    tryDeductCredits,
    createReservation,
    growReservation,
    captureReservation,
    settleReservation,
    getSettledCharge,
    zeroReservation,
    updateAutoTopUpSettings,
    checkAutoTopUp,
    reconcileBatchBalance,
    redeemGiftToken,
  };
}
