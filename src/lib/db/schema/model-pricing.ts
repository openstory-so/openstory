/**
 * Model pricing (#1069) — the platform's only pricing record.
 *
 * `model_pricing` is a snapshot of provider prices, refreshed daily by the
 * Worker cron (`src/lib/cron/refresh-fal-pricing.ts`) for every priced
 * endpoint in fal's catalog. Platform-global, pure derived cache — every row
 * is rebuildable from the provider APIs + our own usage samples. The key is
 * (provider, endpointId, unit) so a re-denominated endpoint gets a fresh row.
 *
 * `model_pricing_history` appends a row whenever a unit price changes (and on
 * first sight), giving a time-series of model costs.
 */

import {
  check,
  index,
  integer,
  primaryKey,
  real,
  snakeCase,
  text,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { generateId } from '../id';

export type ModelPricingProvider = 'fal' | 'openrouter';

/**
 * The observed-units pair, shared by this table, the cron, and
 * `EffectiveFalPricing.observed` — one declaration so a mapping cannot swap
 * the two `number` fields.
 */
export type ObservedUnits = {
  /** Median unitsBilled per image across our own recent generations. */
  medianUnits: number;
  /** How many of our generations back that median. */
  sampleCount: number;
};

export const modelPricing = snakeCase.table(
  'model_pricing',
  {
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    /** Raw provider unit string (e.g. "images", "compute seconds", "units"). */
    unit: text({ length: 30 }).notNull(),
    /** Per-unit price in microdollars, verbatim from the provider's API. */
    unitPriceMicros: integer().notNull(),
    /** Provider's historical estimate of units per call (null = no history). */
    typicalUnitsPerCall: real(),
    /** Median unitsBilled across our own recent generations (null = none). */
    observedMedianUnits: real(),
    /** How many of our generations back the observed median. */
    observedSampleCount: integer().default(0).notNull(),
    /**
     * When this rate was last confirmed by BILLED data (usage/billing-events)
     * rather than the provider's advertised pricing API. Once set, an
     * advertised rate can never overwrite the row — the pricing API has
     * mispriced endpoints ~59× (Grok, #1069); only newer billed data can.
     */
    rateVerifiedAt: integer({ mode: 'timestamp' }),
    /** When the provider's pricing API was last fetched successfully. */
    fetchedAt: integer({ mode: 'timestamp' }).notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.endpointId, table.unit] }),
    // Median and sample count are one fact: (NULL, 42) discards a real
    // signal, (3.5, 0) is an anecdote the estimator only rejects by luck.
    check(
      'model_pricing_observed_pair',
      sql`(${table.observedMedianUnits} IS NULL) = (${table.observedSampleCount} = 0)`
    ),
  ]
);

/**
 * Raw per-generation usage samples — the input to the observed median.
 * Written by `recordFalUsage` for every fal generation that reports
 * `unitsBilled`, including BYOK and unpriced ones (those write no transaction
 * row, so mining the ledger would miss them). Anonymous model telemetry:
 * deliberately no `teamId`, so no FK and no D1 cascade exposure. Pruned to
 * the observation window by the cron.
 */
export const modelUsageObservations = snakeCase.table(
  'model_usage_observations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    /** Units the provider billed for this one call. */
    unitsBilled: real().notNull(),
    /** Assets this one call rendered; the median divides by it (#1069). */
    numImages: integer().default(1).notNull(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_model_usage_obs_endpoint_created').on(
      table.provider,
      table.endpointId,
      table.createdAt
    ),
  ]
);

export const modelPricingHistory = snakeCase.table(
  'model_pricing_history',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    provider: text({ length: 50 }).$type<ModelPricingProvider>().notNull(),
    endpointId: text({ length: 200 }).notNull(),
    unit: text({ length: 30 }).notNull(),
    unitPriceMicros: integer().notNull(),
    recordedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_model_pricing_history_endpoint').on(
      table.provider,
      table.endpointId,
      table.recordedAt
    ),
  ]
);
