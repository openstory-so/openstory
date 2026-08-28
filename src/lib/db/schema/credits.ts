import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

// Enum values as constants (SQLite doesn't have native enums)
const TRANSACTION_TYPES = [
  'credit_purchase',
  'credit_usage',
  'credit_refund',
  'credit_adjustment',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Team credit balance, in microdollars. Decremented in place on every
 * deduction (see `deductCredits`), not derived from the ledger.
 *
 * The CHECK is the backstop under the application-level gates
 * (`requireCredits` / `createReservation` before the work): if a charge
 * would overdraw posted balance, the UPDATE matches zero rows instead of
 * going negative. Open holds reduce *available* (`balance − SUM(remaining
 * WHERE expires_at > now())`), not posted balance (#1310).
 */
export const credits = snakeCase.table(
  'credits',
  {
    teamId: text()
      .primaryKey()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    balance: integer().default(0).notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [check('positive_balance', sql`${table.balance} >= 0`)]
);

export const transactions = snakeCase.table(
  'transactions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    type: text().$type<TransactionType>().notNull(),
    amount: integer().notNull(),
    balanceAfter: integer().notNull(),
    metadata: text({ mode: 'json' }).$defaultFn(() => ({})),
    stripeSessionId: text(),
    description: text(),
    /**
     * Stable key making a deduction idempotent across workflow step retries
     * (convention: `${workflowInstanceId}:<charge-name>`). Null for charges
     * with no retry path (e.g. HTTP single-shot LLM calls).
     */
    idempotencyKey: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_transactions_created_at').on(table.createdAt),
    index('idx_transactions_type').on(table.type),
    index('idx_transactions_team_id').on(table.teamId),
    index('idx_transactions_user_id').on(table.userId),
    uniqueIndex('idx_transactions_stripe_session_id').on(table.stripeSessionId),
    uniqueIndex('idx_transactions_team_idempotency_key')
      .on(table.teamId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);

/**
 * Run envelope (#1310). Holds are not ledger rows: available funds are
 * `credits.balance − SUM(remaining WHERE remaining > 0 AND expires_at > now())`.
 * Abandoned holds expire in the SUM with no UPDATE. Capture posts a new
 * `credit_usage` transaction; leftover is zeroed when the run ends.
 */
export const creditReservations = snakeCase.table(
  'credit_reservations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    sequenceId: text(),
    originalAmount: integer().notNull(),
    remainingAmount: integer().notNull(),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    idempotencyKey: text().notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_credit_reservations_team_idempotency_key').on(
      table.teamId,
      table.idempotencyKey
    ),
    index('idx_credit_reservations_team_expires').on(
      table.teamId,
      table.expiresAt
    ),
    check(
      'non_negative_reservation_remaining',
      sql`${table.remainingAmount} >= 0`
    ),
  ]
);

export const teamBillingSettings = snakeCase.table('team_billing_settings', {
  teamId: text()
    .primaryKey()
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  stripeCustomerId: text(),
  autoTopUpEnabled: integer({ mode: 'boolean' }).default(false).notNull(),
  autoTopUpThresholdMicros: integer().default(5_000_000),
  autoTopUpAmountMicros: integer().default(100_000_000),
  /**
   * Set when an off-session auto-top-up PaymentIntent is declined or
   * otherwise does not succeed. `maybeAutoTopUp` skips a new charge while
   * this is within `AUTO_TOPUP_DECLINE_COOLDOWN_MS` (#1334).
   */
  autoTopUpFailedAt: integer({ mode: 'timestamp' }),
  autoTopUpDeclineCode: text(),
  updatedAt: integer({ mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
});

// Credit Batches — tracks each top-up for future expiration
const CREDIT_BATCH_SOURCES = [
  'stripe_checkout',
  'auto_topup',
  'gift_code',
  'adjustment',
  'migration',
] as const;
export type CreditBatchSource = (typeof CREDIT_BATCH_SOURCES)[number];

export const creditBatches = snakeCase.table(
  'credit_batches',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    originalAmount: integer().notNull(),
    remainingAmount: integer().notNull(),
    source: text().$type<CreditBatchSource>().notNull(),
    transactionId: text().references(() => transactions.id, {
      onDelete: 'set null',
    }),
    expiresAt: integer({ mode: 'timestamp' }).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_credit_batches_team_id').on(table.teamId),
    index('idx_credit_batches_team_remaining_created').on(
      table.teamId,
      table.remainingAmount,
      table.createdAt
    ),
    index('idx_credit_batches_expires_at').on(table.expiresAt),
  ]
);

// Type exports
export type TeamBillingSetting = InferSelectModel<typeof teamBillingSettings>;
