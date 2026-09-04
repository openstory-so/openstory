/**
 * Scoped Billing Sub-module
 * Team-scoped credit operations: balance, deductions, transactions, settings.
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
} from '@/lib/billing/constants';
import {
  type Microdollars,
  micros,
  microsToDisplayUsd,
  microsToUsd,
  negateMicros,
  subtractMicros,
  ZERO_MICROS,
} from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import {
  creditBatches,
  creditReservations,
  credits,
  teamBillingSettings,
  transactions,
} from '@/lib/db/schema/credits';
import type {
  CreditBatchSource,
  TeamBillingSetting,
  TransactionType,
} from '@/lib/db/schema/credits';
import { ValidationError } from '@/lib/errors';
import { getBillingChannel } from '@/lib/realtime';
import { and, count, desc, eq, gte, notExists, sql } from 'drizzle-orm';
import { generateId } from '../id';
import { giftTokenRedemptions, giftTokens } from '../schema';

import { getLogger } from '@/lib/observability/logger';

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
  teamId: string;
  balance: Microdollars;
  reserved: Microdollars;
  available: Microdollars;
  /** Signed ledger amount (negative for usage). Zero when only a hold changed. */
  amountMicros: Microdollars;
  transactionId?: string;
  type?: TransactionType;
}): Promise<void> {
  await getBillingChannel(opts.teamId).emit('billing.balance:updated', {
    teamId: opts.teamId,
    balanceUsd: microsToUsd(opts.balance),
    availableUsd: microsToUsd(opts.available),
    reservedUsd: microsToUsd(opts.reserved),
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
  return 'stripe_checkout';
}

/**
 * Read-only billing methods — balance checks, transaction history, settings.
 */
function createBillingReadMethods(db: Database, teamId: string) {
  async function getBalance(): Promise<Microdollars> {
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId))
      .limit(1);

    if (!row) {
      await db
        .insert(credits)
        .values({ teamId, balance: 0 })
        .onConflictDoNothing({ target: credits.teamId });
      return ZERO_MICROS;
    }

    return micros(row.balance);
  }

  async function reservedSum(now = new Date()): Promise<Microdollars> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${creditReservations.remainingAmount}), 0)`,
      })
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.teamId, teamId),
          sql`${creditReservations.remainingAmount} > 0`,
          sql`${creditReservations.expiresAt} > ${nowSeconds}`
        )
      );
    return micros(Number(row?.total ?? 0));
  }

  async function getAvailable(now = new Date()): Promise<{
    balance: Microdollars;
    reserved: Microdollars;
    available: Microdollars;
  }> {
    const balance = await getBalance();
    const reserved = await reservedSum(now);
    const available =
      balance > reserved ? subtractMicros(balance, reserved) : ZERO_MICROS;
    return { balance, reserved, available };
  }

  async function hasEnoughCredits(
    estimatedCostMicros: Microdollars
  ): Promise<boolean> {
    const { available } = await getAvailable();
    return available >= estimatedCostMicros;
  }

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
    total: number;
  }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions = [eq(transactions.teamId, teamId)];
    if (opts.type) {
      conditions.push(eq(transactions.type, opts.type));
    }
    const whereClause =
      conditions.length === 1 ? conditions[0] : and(...conditions);

    const [rows, countResult] = await Promise.all([
      db
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
        .where(whereClause)
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(transactions)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count ?? 0;
    return { transactions: rows, total };
  }

  async function getBillingSettings(): Promise<TeamBillingSetting> {
    const [row] = await db
      .select()
      .from(teamBillingSettings)
      .where(eq(teamBillingSettings.teamId, teamId))
      .limit(1);

    if (row) return row;

    const [inserted] = await db
      .insert(teamBillingSettings)
      .values({ teamId })
      .onConflictDoNothing({ target: teamBillingSettings.teamId })
      .returning();

    if (inserted) return inserted;

    // Lost the race — peer inserted between our SELECT and INSERT.
    const [existing] = await db
      .select()
      .from(teamBillingSettings)
      .where(eq(teamBillingSettings.teamId, teamId))
      .limit(1);
    if (!existing) {
      throw new Error(
        `getBillingSettings: row missing for team ${teamId} after onConflictDoNothing`
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
  teamId: string,
  userId: string
) {
  const read = createBillingReadMethods(db, teamId);

  async function emitTeamFunds(opts: {
    amountMicros: Microdollars;
    transactionId?: string;
    type?: TransactionType;
  }): Promise<void> {
    const snapshot = await read.getAvailable();
    await emitFundsUpdated({
      teamId,
      ...snapshot,
      amountMicros: opts.amountMicros,
      transactionId: opts.transactionId,
      type: opts.type,
    });
  }

  async function clearAutoTopUpFailure(): Promise<void> {
    await db
      .update(teamBillingSettings)
      .set({
        autoTopUpFailedAt: null,
        autoTopUpDeclineCode: null,
        updatedAt: new Date(),
      })
      .where(eq(teamBillingSettings.teamId, teamId));
  }

  async function recordAutoTopUpFailure(declineCode: string): Promise<void> {
    await db
      .update(teamBillingSettings)
      .set({
        autoTopUpFailedAt: new Date(),
        autoTopUpDeclineCode: declineCode,
        updatedAt: new Date(),
      })
      .where(eq(teamBillingSettings.teamId, teamId));
    await emitTeamFunds({ amountMicros: ZERO_MICROS });
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
    } = {}
  ): Promise<{ newBalance: Microdollars; transactionId: string } | null> {
    if (amountMicros <= 0) {
      throw new ValidationError('Credit amount must be positive');
    }

    await db
      .insert(credits)
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const [updated] = await db
      .update(credits)
      .set({
        balance: sql`${credits.balance} + ${amountMicros}`,
        updatedAt: new Date(),
      })
      .where(eq(credits.teamId, teamId))
      .returning({ balance: credits.balance });

    if (!updated) {
      throw new Error(`addCredits: update returned no row for team ${teamId}`);
    }

    const txType = opts.type ?? 'credit_purchase';

    const rows = await db
      .insert(transactions)
      .values({
        teamId,
        userId,
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
        .where(eq(credits.teamId, teamId));
      return null;
    }

    const insertedRow = rows[0];
    if (!insertedRow) {
      throw new Error(
        `addCredits: transaction insert returned no row for team ${teamId}`
      );
    }
    const transactionId = insertedRow.id;

    await db.insert(creditBatches).values({
      teamId,
      originalAmount: amountMicros,
      remainingAmount: amountMicros,
      source: mapBatchSource(txType, opts.metadata),
      transactionId,
      expiresAt: calculateExpiryDate(),
    });

    const newBalance = micros(updated.balance);
    await emitTeamFunds({
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
      .insert(teamBillingSettings)
      .values({ teamId, stripeCustomerId })
      .onConflictDoUpdate({
        target: teamBillingSettings.teamId,
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
   * team and writes a duplicate ledger row. The balance UPDATE and the
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
      .values({ teamId, balance: 0 })
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
              eq(credits.teamId, teamId),
              notExists(
                db
                  .select({ id: transactions.id })
                  .from(transactions)
                  .where(
                    and(
                      eq(transactions.teamId, teamId),
                      eq(transactions.idempotencyKey, idempotencyKey)
                    )
                  )
              )
            )
          : eq(credits.teamId, teamId)
      );

    // balanceAfter reads the post-UPDATE balance via subquery — the batch
    // statements run sequentially inside one transaction, so this sees the
    // decremented value. On a replay the INSERT no-ops, so the (stale) value
    // is never written.
    const insertTransaction = db
      .insert(transactions)
      .values({
        teamId,
        userId,
        type: 'credit_usage' as TransactionType,
        amount: negateMicros(chargedAmount),
        balanceAfter: sql`(select ${credits.balance} from ${credits} where ${credits.teamId} = ${teamId})`,
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
      .where(eq(credits.teamId, teamId));

    const [, insertedRows, balanceRows] = await db.batch([
      updateBalance,
      insertTransaction,
      readBackBalance,
    ]);

    const balanceRow = balanceRows[0];
    if (!balanceRow) {
      throw new Error(
        `deductCredits: credits row missing for team ${teamId} after batch`
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
          `deductCredits: transaction insert returned no row for team ${teamId}`
        );
      }
      // Replay of an already-applied deduction — recover the original
      // transaction id. Must not throw: the charge landed on a prior attempt.
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.teamId, teamId),
            eq(transactions.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          `deductCredits: no transaction row for team ${teamId} key ${idempotencyKey} after conflict no-op`
        );
      }
      transactionId = existing.id;
    }

    if (isNewCharge) {
      await emitTeamFunds({
        amountMicros: negateMicros(chargedAmount),
        transactionId,
        type: 'credit_usage',
      });
    }

    void maybeAutoTopUp().catch((err) => {
      logger.error('Auto top-up failed after deduction', {
        teamId,
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
          eq(transactions.teamId, teamId),
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
        .where(eq(credits.teamId, teamId))
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
      .values({ teamId, balance: 0 })
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
          eq(credits.teamId, teamId),
          gte(credits.balance, amountMicros),
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.teamId, teamId),
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
            teamId: sql<string>`${teamId}`.as('team_id'),
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
          .where(and(eq(credits.teamId, teamId), sql`changes() > 0`))
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id });

    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));

    const [, insertedRows, balanceRows] = await db.batch([
      updateBalance,
      insertTransaction,
      readBackBalance,
    ]);

    const balanceRow = balanceRows[0];
    if (!balanceRow) {
      throw new Error(
        `tryDebit: credits row missing for team ${teamId} after batch`
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

    await emitTeamFunds({
      amountMicros: signedAmount,
      transactionId,
      type: txType,
    });

    if (txType === 'credit_usage') {
      void maybeAutoTopUp().catch((err) => {
        logger.error('Auto top-up failed after reservation debit', {
          teamId,
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

  async function createReservation(
    amountMicros: Microdollars,
    opts: {
      idempotencyKey: string;
      sequenceId?: string;
      ttlMs?: number;
    }
  ): Promise<CreateReservationResult> {
    if (amountMicros <= 0) return { ok: false };

    const existing = await db
      .select()
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.teamId, teamId),
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
      .values({ teamId, balance: 0 })
      .onConflictDoNothing();

    const reservationId = generateId();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (opts.ttlMs ?? RESERVATION_TTL_MS)
    );
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expiresSeconds = Math.floor(expiresAt.getTime() / 1000);

    const inserted = await db
      .insert(creditReservations)
      .select(
        db
          .select({
            id: sql<string>`${reservationId}`.as('id'),
            teamId: sql<string>`${teamId}`.as('team_id'),
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
          })
          .from(credits)
          .where(
            and(
              eq(credits.teamId, teamId),
              sql`${credits.balance} - coalesce((
                select sum(${creditReservations.remainingAmount})
                from ${creditReservations}
                where ${creditReservations.teamId} = ${teamId}
                  and ${creditReservations.remainingAmount} > 0
                  and ${creditReservations.expiresAt} > ${nowSeconds}
              ), 0) >= ${amountMicros}`
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
            eq(creditReservations.teamId, teamId),
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

    await emitTeamFunds({ amountMicros: ZERO_MICROS });
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
            eq(creditReservations.teamId, teamId)
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
          eq(creditReservations.teamId, teamId),
          sql`${extraMicros} <= (
            (select ${credits.balance} from ${credits} where ${credits.teamId} = ${teamId})
            - coalesce((
              select sum(${creditReservations.remainingAmount})
              from ${creditReservations}
              where ${creditReservations.teamId} = ${teamId}
                and ${creditReservations.remainingAmount} > 0
                and ${creditReservations.expiresAt} > ${nowSeconds}
            ), 0)
          )`
        )
      )
      .returning({ remaining: creditReservations.remainingAmount });

    if (!updated) return { ok: false };
    await emitTeamFunds({ amountMicros: ZERO_MICROS });
    return { ok: true, remaining: micros(updated.remaining) };
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

    // Replay before grow — a retried over-actual capture must not inflate
    // remaining a second time.
    const already = await getTransactionByIdempotencyKey(opts.idempotencyKey);
    if (already) {
      const captured = micros(Math.abs(already.amount));
      return {
        ok: true,
        captured,
        skippedDeltaMicros: skippedCaptureDelta(actualMicros, captured),
      };
    }

    const [reservation] = await db
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.teamId, teamId)
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
        and ${creditReservations.teamId} = ${teamId}
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
          eq(creditReservations.teamId, teamId),
          sql`${extraExpr} > 0`,
          sql`${extraExpr} <= (
            (select ${credits.balance} from ${credits} where ${credits.teamId} = ${teamId})
            - coalesce((
              select sum(${creditReservations.remainingAmount})
              from ${creditReservations}
              where ${creditReservations.teamId} = ${teamId}
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
          eq(credits.teamId, teamId),
          sql`${takeExpr} > 0`,
          sql`${credits.balance} >= ${takeExpr}`,
          notExists(
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(
                and(
                  eq(transactions.teamId, teamId),
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
            teamId: sql<string>`${teamId}`.as('team_id'),
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
          .where(and(eq(credits.teamId, teamId), sql`changes() > 0`))
      )
      .onConflictDoNothing()
      .returning({ id: transactions.id, amount: transactions.amount });

    const reduceRemaining = db
      .update(creditReservations)
      .set({
        remainingAmount: sql`${creditReservations.remainingAmount} - min(${creditReservations.remainingAmount}, ${actualMicros})`,
      })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.teamId, teamId),
          sql`changes() > 0`
        )
      );

    const readBackBalance = db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));

    const [, , insertedRows, , balanceRows] = await db.batch([
      growHold,
      updateBalance,
      insertTransaction,
      reduceRemaining,
      readBackBalance,
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
        };
      }
      return {
        ok: true,
        captured: ZERO_MICROS,
        skippedDeltaMicros: skippedCaptureDelta(actualMicros, ZERO_MICROS),
      };
    }

    const captured = micros(Math.abs(inserted.amount));
    const balanceRow = balanceRows[0];
    const newBalance = micros(balanceRow?.balance ?? 0);

    await emitTeamFunds({
      amountMicros: negateMicros(captured),
      transactionId: inserted.id,
      type: txType,
    });

    void maybeAutoTopUp().catch((err) => {
      logger.error('Auto top-up failed after reservation capture', {
        teamId,
        balanceMicros: newBalance,
        err,
      });
    });

    return {
      ok: true,
      captured,
      skippedDeltaMicros: skippedCaptureDelta(actualMicros, captured),
    };
  }

  async function zeroReservation(reservationId: string): Promise<void> {
    await db
      .update(creditReservations)
      .set({ remainingAmount: 0 })
      .where(
        and(
          eq(creditReservations.id, reservationId),
          eq(creditReservations.teamId, teamId)
        )
      );
    await emitTeamFunds({ amountMicros: ZERO_MICROS });
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
      .insert(teamBillingSettings)
      .values({
        teamId,
        autoTopUpEnabled: settings.enabled,
        autoTopUpThresholdMicros: settings.thresholdMicros,
        autoTopUpAmountMicros: settings.amountMicros,
        autoTopUpFailedAt: null,
        autoTopUpDeclineCode: null,
      })
      .onConflictDoUpdate({
        target: teamBillingSettings.teamId,
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
    // auto-top-up for a team whose settings page says it is on.
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
        teamId,
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
          eq(transactions.teamId, teamId),
          sql`json_extract(${transactions.metadata}, '$.autoTopUp') = true`
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);

    if (recentAutoTopUp) {
      const elapsed = Date.now() - recentAutoTopUp.createdAt.getTime();
      if (elapsed < AUTO_TOPUP_COOLDOWN_MS) {
        logger.info(
          `Cooldown active for team ${teamId}, skipping (${Math.round(elapsed / 1000)}s ago)`
        );
        return;
      }
    }

    const topUpMicros = micros(settings.autoTopUpAmountMicros);

    // Dynamic import: this module is in the client module graph (via
    // middleware → scoped), and a static `stripe` import ships the Stripe
    // Node SDK to the browser (#1253). Only the server ever runs this path.
    const { getStripeOrThrow } = await import('@/lib/billing/stripe');
    const stripe = getStripeOrThrow();
    const amountCents = totalCheckoutCents(topUpMicros);

    // Every exit below leaves auto-top-up silently dead for this team while
    // the settings page still advertises it as on — so each one logs (#1099).
    const customer = await stripe.customers.retrieve(settings.stripeCustomerId);
    if (customer.deleted) {
      logger.warn('Auto top-up skipped: Stripe customer deleted', {
        teamId,
        stripeCustomerId: settings.stripeCustomerId,
      });
      return;
    }

    const defaultPaymentMethod =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      customer.invoice_settings?.default_payment_method;
    if (!defaultPaymentMethod) {
      logger.warn('Auto top-up skipped: no default payment method', {
        teamId,
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
          teamId,
          userId,
          type: 'auto_top_up',
        },
      });
    } catch (err) {
      const declineCode = stripeDeclineCode(err);
      if (declineCode) {
        logger.error('Auto top-up declined', {
          teamId,
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
        teamId,
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
      .where(eq(credits.teamId, teamId))
      .limit(1);

    const runningBalance = micros(balanceRow?.balance ?? 0);

    const [batchRow] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${creditBatches.remainingAmount}), 0)`,
      })
      .from(creditBatches)
      .where(eq(creditBatches.teamId, teamId));

    const batchTotal = micros(batchRow?.total ?? 0);

    return {
      runningBalance,
      batchTotal,
      drift: runningBalance - batchTotal,
    };
  }

  /**
   * Redeem a gift token for a team. Adds credits via the billing sub-module.
   * Caller must provide an addCredits function (from billing sub-module) to avoid
   * circular dependency.
   */
  async function redeemGiftToken(opts: {
    code: string;
    teamId: string;
    userId: string;
    addCredits: (
      amountMicros: Microdollars,
      creditOpts: {
        type?: TransactionType;
        description?: string;
        metadata?: Record<string, unknown>;
      }
    ) => Promise<{ newBalance: Microdollars; transactionId: string } | null>;
  }): Promise<{ newBalance: number; amountUsd: number }> {
    const normalizedCode = opts.code.trim().toUpperCase();

    // Find the token
    const [token] = await db
      .select()
      .from(giftTokens)
      .where(eq(giftTokens.code, normalizedCode))
      .limit(1);

    if (!token) {
      throw new ValidationError('Invalid gift code');
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new ValidationError('This gift code has expired');
    }

    // Count existing redemptions
    const [redemptionRow] = await db
      .select({ value: count() })
      .from(giftTokenRedemptions)
      .where(eq(giftTokenRedemptions.giftTokenId, token.id));

    const redemptionCount = redemptionRow?.value ?? 0;

    if (redemptionCount >= token.maxRedemptions) {
      throw new ValidationError('This gift code has been fully redeemed');
    }

    // Record redemption -- unique index on (giftTokenId, teamId) prevents duplicates
    const [inserted] = await db
      .insert(giftTokenRedemptions)
      .values({
        id: generateId(),
        giftTokenId: token.id,
        teamId: opts.teamId,
        userId: opts.userId,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      throw new ValidationError(
        'Your team has already redeemed this gift code'
      );
    }

    const amountMicros = micros(token.amountMicros);

    // Add credits to team
    const result = await opts.addCredits(amountMicros, {
      type: 'credit_adjustment',
      description: `Gift code redeemed: ${normalizedCode} (${microsToDisplayUsd(amountMicros)})`,
      metadata: { giftTokenId: token.id, giftCode: normalizedCode },
    });

    return {
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
    zeroReservation,
    updateAutoTopUpSettings,
    checkAutoTopUp,
    reconcileBatchBalance,
    redeemGiftToken,
  };
}
