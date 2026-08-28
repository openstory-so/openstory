/**
 * Hourly fal billing reconcile (#1069).
 *
 * Audits every platform-billed generation against fal's per-request bill
 * (`/v1/models/billing-events`), joined to our credit transactions by the
 * fal request id the workflows store in transaction metadata:
 *
 * 1. Corrects `model_pricing` rates the moment the bill disagrees — so a
 *    novel endpoint's stale advertised rate is fixed within the hour of its
 *    first use, not at the next nightly refresh.
 * 2. Reports per-transaction deltas (charged vs billed) via PostHog + error
 *    log. Report-only: no retroactive ledger adjustments.
 *
 * Windowing is stateless: each run covers [now-75min, now-5min). Events lag
 * completion by 1s–5min (the freshest 5min are excluded as still-settling),
 * and the 15min overlap between runs means a late event is seen by the next
 * run rather than lost. Duplicate delta reports across the overlap are
 * possible and harmless.
 */

import { getDb } from '#db-client';
import { getEnv } from '#env';
import {
  type FalBillingEvent,
  fetchFalBillingEvents,
} from '@/lib/ai/fal-pricing-fetch';
import { reportBillingDrift } from '@/lib/billing/billing-observability';
import { FAL_UNVERIFIED_SIBLINGS } from '@/lib/ai/fal-typical-units';
import { usdToMicros } from '@/lib/billing/money';
import {
  modelPricing,
  modelPricingHistory,
  transactions,
} from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import { and, eq, gte, lte } from 'drizzle-orm';
import {
  type PricingRefreshDb,
  writeObservedUnits,
} from './refresh-fal-pricing';

const logger = getLogger(['openstory', 'cron', 'reconcile-fal-billing']);

/**
 * Cron expression — must match `wrangler.jsonc` `triggers.crons` (default AND
 * production blocks); `scheduled()` in `src/server.ts` routes on it.
 */
export const FAL_BILLING_RECONCILE_CRON = '37 * * * *';

/** Events younger than this are excluded — the billing pipeline may lag. */
const SETTLING_MS = 5 * 60 * 1000;
/** Lookback per run; overlaps the previous run so late events aren't lost. */
const WINDOW_MS = 75 * 60 * 1000;
/** Charged-vs-billed differences below this are float noise, not drift. */
const DRIFT_EPSILON_MICROS = 100; // $0.0001

export type FalBillingReconcileSummary = {
  events: number;
  matchedTransactions: number;
  drifts: number;
  rateCorrections: number;
  /** Endpoints whose observed_median_units were patched from our samples. */
  observedEndpoints: number;
  /** Events with no matching transaction (scripts, unpriced $0 charges…). */
  unmatchedEvents: number;
};

type UsageMetadata = {
  costMicros?: number;
  requestId?: string;
  endpointId?: string;
};

export async function reconcileFalBilling(
  deps: { db?: PricingRefreshDb; billingKey?: string; now?: Date } = {}
): Promise<FalBillingReconcileSummary | null> {
  const billingKey =
    deps.billingKey ??
    (getEnv() as ReturnType<typeof getEnv> & { FAL_BILLING_KEY?: string })
      .FAL_BILLING_KEY;
  if (!billingKey) {
    logger.error(
      'FAL_BILLING_KEY is not configured — cannot reconcile charges against billed usage'
    );
    return null;
  }

  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const end = new Date(now.getTime() - SETTLING_MS);
  const start = new Date(end.getTime() - WINDOW_MS);

  const events = await fetchFalBillingEvents(billingKey, start, end);
  const summary: FalBillingReconcileSummary = {
    events: events.length,
    matchedTransactions: 0,
    drifts: 0,
    rateCorrections: 0,
    observedEndpoints: 0,
    unmatchedEvents: 0,
  };

  summary.rateCorrections = await correctRates(db, events, now);
  summary.observedEndpoints = await writeObservedUnits(db, now);

  if (events.length === 0) {
    logger.info('fal billing reconcile: no events in window', { ...summary });
    return summary;
  }

  // Join events to our usage transactions by the fal request id in metadata.
  // The transaction window is wider than the event window: a transaction is
  // written at completion, its event up to minutes later.
  const txRows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.type, 'credit_usage'),
        gte(transactions.createdAt, new Date(start.getTime() - WINDOW_MS)),
        lte(transactions.createdAt, now)
      )
    );
  const txByRequestId = new Map<
    string,
    { teamId: string; id: string; chargedMicros: number }
  >();
  for (const tx of txRows) {
    const meta = (tx.metadata ?? {}) as UsageMetadata;
    if (!meta.requestId) continue;
    txByRequestId.set(meta.requestId, {
      teamId: tx.teamId,
      id: tx.id,
      chargedMicros: meta.costMicros ?? -tx.amount,
    });
  }

  for (const event of events) {
    const tx = txByRequestId.get(event.requestId);
    if (!tx) {
      // Legitimate: BYOK bills the team's own account (never seen here),
      // scripts/e2e charge no team, and unpriced endpoints charge $0.
      summary.unmatchedEvents++;
      continue;
    }
    summary.matchedTransactions++;
    const deltaMicros = event.costMicros - tx.chargedMicros;
    if (Math.abs(deltaMicros) <= DRIFT_EPSILON_MICROS) continue;
    summary.drifts++;
    reportBillingDrift({
      teamId: tx.teamId,
      transactionId: tx.id,
      requestId: event.requestId,
      endpointId: event.endpointId,
      chargedMicros: tx.chargedMicros,
      billedMicros: event.costMicros,
    });
  }

  logger.info('fal billing reconcile complete', { ...summary });
  return summary;
}

/**
 * Correct `model_pricing` unit prices from the events' billed rates, so the
 * NEXT charge on a drifting endpoint is right. The latest event per endpoint
 * wins; matching rows get `rateVerifiedAt` stamped either way.
 */
async function correctRates(
  db: PricingRefreshDb,
  events: FalBillingEvent[],
  now: Date
): Promise<number> {
  const latestByEndpoint = new Map<string, FalBillingEvent>();
  for (const event of events) {
    if (!Number.isFinite(event.unitPriceUsd) || event.unitPriceUsd <= 0) {
      continue;
    }
    const prev = latestByEndpoint.get(event.endpointId);
    if (!prev || event.timestamp > prev.timestamp) {
      latestByEndpoint.set(event.endpointId, event);
    }
  }

  const rows = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));
  const rowsByEndpoint = new Map(rows.map((r) => [r.endpointId, r]));

  let corrections = 0;
  for (const [endpointId, event] of latestByEndpoint) {
    const billedMicros = usdToMicros(event.unitPriceUsd);
    const row = rowsByEndpoint.get(endpointId);
    if (!row) continue; // nightly refresh adds it with the billed unit name
    if (row.unitPriceMicros === billedMicros) {
      await db
        .update(modelPricing)
        .set({ rateVerifiedAt: now, updatedAt: now })
        .where(
          and(
            eq(modelPricing.provider, 'fal'),
            eq(modelPricing.endpointId, endpointId),
            eq(modelPricing.unit, row.unit)
          )
        );
      continue;
    }
    logger.warn('billed unit price disagrees with model_pricing — correcting', {
      endpointId,
      storedMicros: row.unitPriceMicros,
      billedMicros,
    });
    await db
      .update(modelPricing)
      .set({
        unitPriceMicros: billedMicros,
        rateVerifiedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
    await db.insert(modelPricingHistory).values({
      provider: 'fal',
      endpointId,
      unit: row.unit,
      unitPriceMicros: billedMicros,
      recordedAt: now,
    });
    corrections++;
  }

  corrections += await copySiblingRates(
    db,
    latestByEndpoint,
    rowsByEndpoint,
    now
  );
  return corrections;
}

/**
 * Stamp an unverified sibling (H3 Max t2v) with the source's billed unit
 * price so it does not sit on fal's advertised compute-seconds lie (#1382).
 * Unit re-denomination (PK includes unit) is left to the nightly snapshot.
 */
async function copySiblingRates(
  db: PricingRefreshDb,
  latestByEndpoint: Map<string, FalBillingEvent>,
  rowsByEndpoint: Map<string, typeof modelPricing.$inferSelect>,
  now: Date
): Promise<number> {
  let corrections = 0;
  for (const [target, source] of Object.entries(FAL_UNVERIFIED_SIBLINGS)) {
    if (latestByEndpoint.has(target)) continue;
    const sourceEvent = latestByEndpoint.get(source);
    const sourceRow = rowsByEndpoint.get(source);
    const targetRow = rowsByEndpoint.get(target);
    if (!targetRow) continue;
    const sourceMicros = sourceEvent
      ? usdToMicros(sourceEvent.unitPriceUsd)
      : sourceRow?.rateVerifiedAt != null
        ? sourceRow.unitPriceMicros
        : undefined;
    if (sourceMicros == null) continue;
    if (targetRow.unitPriceMicros === sourceMicros) {
      if (targetRow.rateVerifiedAt == null) {
        await db
          .update(modelPricing)
          .set({ rateVerifiedAt: now, updatedAt: now })
          .where(
            and(
              eq(modelPricing.provider, 'fal'),
              eq(modelPricing.endpointId, target),
              eq(modelPricing.unit, targetRow.unit)
            )
          );
      }
      continue;
    }
    logger.warn(
      'unverified sibling inheriting billed rate from source endpoint',
      {
        target,
        source,
        storedMicros: targetRow.unitPriceMicros,
        billedMicros: sourceMicros,
      }
    );
    await db
      .update(modelPricing)
      .set({
        unitPriceMicros: sourceMicros,
        rateVerifiedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, target),
          eq(modelPricing.unit, targetRow.unit)
        )
      );
    await db.insert(modelPricingHistory).values({
      provider: 'fal',
      endpointId: target,
      unit: targetRow.unit,
      unitPriceMicros: sourceMicros,
      recordedAt: now,
    });
    corrections++;
  }
  return corrections;
}
