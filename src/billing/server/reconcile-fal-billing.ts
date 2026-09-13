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
 * 3. Replays recent observations through each verified rate card and
 *    reports the drift per endpoint (#1605), storing the median ratio as the
 *    card's calibration. Needs no billing key: the actual cost is
 *    `unitsBilled × verified unitPrice`, both already in D1.
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
} from './fal-pricing-fetch';
import {
  reportBillingDrift,
  reportRateCardDrift,
} from '@/billing/billing-observability';
import { FAL_UNVERIFIED_SIBLINGS } from '@/billing/fal-typical-units';
import { micros, microsToUsd, usdToMicros } from '@/billing/money';
import { evaluateRateCard } from '@/billing/rate-card/evaluate';
import {
  hasUnpricedVideoInput,
  pricingLeversSchema,
} from '@/billing/rate-card/levers';
import { rateCardSchema } from '@/billing/rate-card/rate-card.schema';
import {
  modelPricing,
  modelPricingHistory,
  modelUsageObservations,
  transactions,
} from '@/platform/server/db/schema';
import { getLogger } from '@/platform/logger';
import { and, eq, gt, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
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
  /** Endpoints whose verified rate card was replayed against the bill (#1605). */
  rateCardsCalibrated: number;
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
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  // Rate-card drift reads only D1, so it runs before the billing-key gate.
  const rateCardsCalibrated = await calibrateRateCards(db, now);

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

  const end = new Date(now.getTime() - SETTLING_MS);
  const start = new Date(end.getTime() - WINDOW_MS);

  const events = await fetchFalBillingEvents(billingKey, start, end);
  const summary: FalBillingReconcileSummary = {
    events: events.length,
    matchedTransactions: 0,
    drifts: 0,
    rateCorrections: 0,
    observedEndpoints: 0,
    rateCardsCalibrated,
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

/** Same window and per-endpoint cap as the observed median. */
const CALIBRATION_WINDOW_DAYS = 90;
const CALIBRATION_SAMPLES_PER_ENDPOINT = 200;

/** Raw-SQL JSON columns arrive as text; a malformed row fails the schema parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Sorted-list quantile, nearest rank. */
function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Replay every recent observation that recorded its request levers through
 * the endpoint's verified rate card and compare to what fal billed:
 * `ratio = (unitsBilled × verified unitPrice) / card(requestParams)`. The
 * median is stored as the card's calibration — the estimator multiplies by
 * it once `MIN_OBSERVED_SAMPLES` back it — and every endpoint is reported
 * (`rate_card_drift`), with a warn outside the drift band. Rows whose unit
 * price is not bill-verified are skipped: an advertised rate would only
 * compare the page with itself. So is a card past its promo end — the
 * estimator no longer uses it (`readRateCard`), and replaying post-promo
 * bills through it would only report the promo. Report + calibration only;
 * no ledger change.
 */
export async function calibrateRateCards(
  db: PricingRefreshDb,
  now: Date
): Promise<number> {
  const rows = await db
    .select()
    .from(modelPricing)
    .where(
      and(
        eq(modelPricing.provider, 'fal'),
        eq(modelPricing.rateCardVerified, true),
        isNotNull(modelPricing.rateCard),
        isNotNull(modelPricing.rateVerifiedAt),
        or(
          isNull(modelPricing.rateCardExpiresAt),
          gt(modelPricing.rateCardExpiresAt, now)
        )
      )
    );
  if (rows.length === 0) return 0;

  const cutoff = new Date(
    now.getTime() - CALIBRATION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  // Newest-first cap per endpoint in SQL (the `computeObservedUnits` shape):
  // once every generation records levers, the window holds tens of
  // thousands of JSON rows and a busy model must not pull them all into
  // the Worker to keep 200.
  const observations = await db.all<{
    endpoint_id: string;
    units_billed: number;
    request_params: string;
  }>(sql`
    SELECT endpoint_id, units_billed, request_params FROM (
      SELECT
        ${modelUsageObservations.endpointId} AS endpoint_id,
        ${modelUsageObservations.unitsBilled} AS units_billed,
        ${modelUsageObservations.requestParams} AS request_params,
        ROW_NUMBER() OVER (
          PARTITION BY ${modelUsageObservations.endpointId}
          ORDER BY ${modelUsageObservations.createdAt} DESC
        ) AS rn
      FROM ${modelUsageObservations}
      WHERE ${modelUsageObservations.provider} = 'fal'
        AND ${modelUsageObservations.requestParams} IS NOT NULL
        AND ${modelUsageObservations.createdAt} > ${Math.floor(cutoff.getTime() / 1000)}
    ) WHERE rn <= ${CALIBRATION_SAMPLES_PER_ENDPOINT}
  `);
  const byEndpoint = new Map<string, typeof observations>();
  for (const observation of observations) {
    const list = byEndpoint.get(observation.endpoint_id) ?? [];
    list.push(observation);
    byEndpoint.set(observation.endpoint_id, list);
  }

  let calibrated = 0;
  for (const row of rows) {
    const samples = byEndpoint.get(row.endpointId);
    if (!samples?.length) continue;
    const card = rateCardSchema.safeParse(row.rateCard);
    if (!card.success) continue; // logged on the read path
    const unitUsd = microsToUsd(micros(row.unitPriceMicros));
    const ratios: number[] = [];
    let refused = 0;
    for (const sample of samples) {
      const levers = pricingLeversSchema.safeParse(
        parseJson(sample.request_params)
      );
      // A clip sample with no seconds lever would replay at the no-video
      // rate and drag the median — refused, not guessed.
      if (
        !levers.success ||
        sample.units_billed <= 0 ||
        hasUnpricedVideoInput(levers.data)
      ) {
        refused++;
        continue;
      }
      try {
        const { usd } = evaluateRateCard(card.data, levers.data);
        ratios.push((sample.units_billed * unitUsd) / usd);
      } catch {
        refused++;
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const medianRatio = quantile(ratios, 0.5);
    reportRateCardDrift({
      endpointId: row.endpointId,
      sampleCount: ratios.length,
      refused,
      medianRatio,
      p90Ratio: quantile(ratios, 0.9),
    });
    await db
      .update(modelPricing)
      .set({
        rateCardCalibration: medianRatio,
        rateCardCalibrationSamples: ratios.length,
        updatedAt: now,
      })
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, row.endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
    calibrated++;
  }
  return calibrated;
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
