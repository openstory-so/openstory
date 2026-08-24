/**
 * Fal pricing API client, shared by the daily Worker cron
 * (`refresh-fal-pricing`) and `bun scripts/refresh-fal-pricing.ts`.
 *
 * 1. GET /v1/models — enumerate the full active catalog (paginated).
 * 2. GET /v1/models/pricing — unit_price + raw unit, batches of ≤50 ids.
 * 3. POST /v1/models/pricing/estimate — typical units per call, heavily
 *    rate-limited (~1 req/s), so only fetched for endpoints we actually use.
 *
 * `unit` is stored verbatim — the catalog reports ~30 distinct strings
 * ("images", "compute seconds", "videos", "5 seconds", even ""). Billing never
 * needs it (cost = unitsBilled × unitPrice); estimation maps it to a strategy
 * at read time in `fal-cost.ts`.
 */
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'fal-pricing-fetch']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Catalog enumeration
// ============================================================================

type ModelsPage = {
  models: { endpoint_id: string }[];
  has_more: boolean;
  next_cursor: string | null;
};

/** All active endpoint ids in fal's catalog (~1,400 as of 2026-07). */
export async function fetchFalCatalogIds(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL('https://api.fal.ai/v1/models');
    url.searchParams.set('status', 'active');
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!resp.ok) {
      throw new Error(
        `fal models API HTTP ${resp.status}: ${await resp.text()}`
      );
    }
    const page: ModelsPage = await resp.json();
    ids.push(...page.models.map((m) => m.endpoint_id));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return [...new Set(ids)];
}

// ============================================================================
// Unit prices
// ============================================================================

export type FalUnitPrice = {
  endpointId: string;
  /** Per-unit price in USD, verbatim from the pricing API. */
  unitPriceUsd: number;
  /** Raw unit string, verbatim (e.g. "images", "compute seconds", "units"). */
  unit: string;
};

type PriceEntry = {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency: string;
};

/** The pricing API rejects requests above ~50 endpoint ids. */
const PRICE_BATCH_SIZE = 50;
const PRICE_BATCH_DELAY_MS = 200;
const PRICE_MAX_ATTEMPTS = 3;
const PRICE_BACKOFF_MS = 2_000;

type PriceBatchResult =
  | { status: 'ok'; entries: PriceEntry[] }
  | { status: 'rejected' } // hard 4xx — some id in the batch is refused
  | { status: 'failed' }; // rate limit / outage, even after retries

async function fetchPriceBatch(
  apiKey: string,
  endpoints: string[]
): Promise<PriceBatchResult> {
  for (let attempt = 1; attempt <= PRICE_MAX_ATTEMPTS; attempt++) {
    let entries: PriceEntry[];
    try {
      const url = new URL('https://api.fal.ai/v1/models/pricing');
      url.searchParams.set('endpoint_id', endpoints.join(','));
      const resp = await fetch(url, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      // Retry throttling/outages with backoff; bisecting on a 429 would only
      // add requests to an already-throttled endpoint.
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < PRICE_MAX_ATTEMPTS) {
          await sleep(retryAfterMs(resp, attempt, PRICE_BACKOFF_MS));
          continue;
        }
        return { status: 'failed' };
      }
      if (!resp.ok) return { status: 'rejected' };
      const data: { prices: PriceEntry[] } = await resp.json();
      entries = data.prices;
    } catch {
      if (attempt < PRICE_MAX_ATTEMPTS) {
        await sleep(PRICE_BACKOFF_MS * attempt);
        continue;
      }
      return { status: 'failed' };
    }
    return { status: 'ok', entries };
  }
  return { status: 'failed' };
}

/**
 * Fetch a batch, bisecting on a hard rejection so one id the API refuses
 * cannot lose the other 49 prices in its batch. Transient failures are not
 * bisected — the whole batch is reported failed.
 */
async function fetchPriceBatchBisecting(
  apiKey: string,
  endpoints: string[],
  failed: string[]
): Promise<PriceEntry[]> {
  const result = await fetchPriceBatch(apiKey, endpoints);
  if (result.status === 'ok') return result.entries;
  if (result.status === 'failed' || endpoints.length === 1) {
    failed.push(...endpoints);
    return [];
  }
  const mid = Math.ceil(endpoints.length / 2);
  return [
    ...(await fetchPriceBatchBisecting(
      apiKey,
      endpoints.slice(0, mid),
      failed
    )),
    ...(await fetchPriceBatchBisecting(apiKey, endpoints.slice(mid), failed)),
  ];
}

export type FalUnitPrices = {
  prices: FalUnitPrice[];
  /** Requested ids the pricing API errored on (distinct from "no price"). */
  failedEndpoints: string[];
};

/**
 * Fetch per-unit prices for the given endpoints. Ids the API has no price for
 * are simply absent from the result (~50 of the catalog today); ids it errors
 * on land in `failedEndpoints`. Non-positive prices are dropped with a log —
 * a 0 or null price would bill every generation on that endpoint as free.
 */
export async function fetchFalUnitPrices(
  apiKey: string,
  endpoints: string[]
): Promise<FalUnitPrices> {
  const failedEndpoints: string[] = [];
  const prices: FalUnitPrice[] = [];
  for (let i = 0; i < endpoints.length; i += PRICE_BATCH_SIZE) {
    const batch = endpoints.slice(i, i + PRICE_BATCH_SIZE);
    const entries = await fetchPriceBatchBisecting(
      apiKey,
      batch,
      failedEndpoints
    );
    for (const p of entries) {
      if (!Number.isFinite(p.unit_price) || p.unit_price <= 0) {
        logger.warn(
          'fal pricing returned a non-positive unit_price — skipped',
          {
            endpointId: p.endpoint_id,
            unitPrice: p.unit_price,
          }
        );
        continue;
      }
      prices.push({
        endpointId: p.endpoint_id,
        unitPriceUsd: p.unit_price,
        unit: p.unit,
      });
    }
    if (i + PRICE_BATCH_SIZE < endpoints.length) {
      await sleep(PRICE_BATCH_DELAY_MS);
    }
  }
  if (failedEndpoints.length > 0) {
    logger.warn('fal pricing API errored on some endpoints', {
      count: failedEndpoints.length,
      endpoints: failedEndpoints.slice(0, 10),
    });
  }
  return { prices, failedEndpoints };
}

// ============================================================================
// Billed rates — GET /v1/models/usage (needs an admin-scoped key)
// ============================================================================

export type FalBilledRate = {
  endpointId: string;
  /** The unit fal ACTUALLY billed in (can disagree with the pricing API). */
  unit: string;
  unitPriceUsd: number;
  /** Total billed on this endpoint in the window, for conflict resolution. */
  costUsd: number;
};

type UsageEntry = {
  endpoint_id: string;
  unit: string;
  unit_price: number;
  cost: number;
};

/**
 * The unit + unit_price fal actually billed per endpoint over the last
 * `days`, from the usage API — the bill itself, so it cannot disagree with
 * reality. Advertised pricing can use a different unit or rate and materially
 * undercharge. The refresh overlays billed rates over the pricing API's answers.
 *
 * Only covers endpoints with usage in the window — exactly the ones we bill.
 * If one endpoint shows two units (fal re-denominated mid-window), the
 * higher-spend entry wins.
 */
export async function fetchFalBilledRates(
  billingKey: string,
  days = 30
): Promise<FalBilledRate[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const url = new URL('https://api.fal.ai/v1/models/usage');
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('expand', 'summary');

  const resp = await fetch(url, {
    headers: { Authorization: `Key ${billingKey}` },
  });
  if (!resp.ok) {
    throw new Error(`fal usage API HTTP ${resp.status}: ${await resp.text()}`);
  }
  const data: { summary?: UsageEntry[] } = await resp.json();

  const byEndpoint = new Map<string, FalBilledRate>();
  for (const entry of data.summary ?? []) {
    if (!Number.isFinite(entry.unit_price) || entry.unit_price <= 0) continue;
    const rate: FalBilledRate = {
      endpointId: entry.endpoint_id,
      unit: entry.unit,
      unitPriceUsd: entry.unit_price,
      costUsd: Number.isFinite(entry.cost) ? entry.cost : 0,
    };
    const existing = byEndpoint.get(entry.endpoint_id);
    if (!existing) {
      byEndpoint.set(entry.endpoint_id, rate);
    } else if (rate.costUsd > existing.costUsd) {
      logger.warn(
        'fal usage reports two billed units for one endpoint — keeping the higher-spend one',
        { endpointId: entry.endpoint_id, units: [existing.unit, rate.unit] }
      );
      byEndpoint.set(entry.endpoint_id, rate);
    }
  }
  return [...byEndpoint.values()];
}

// ============================================================================
// Billing events — per-request billed cost (needs an admin-scoped key)
// ============================================================================

export type FalBillingEvent = {
  requestId: string;
  endpointId: string;
  /** ISO timestamp of the billing event. */
  timestamp: string;
  outputUnits: number;
  unitPriceUsd: number;
  /** What fal actually charged for this one request, in microdollars. */
  costMicros: number;
};

type BillingEventEntry = {
  request_id: string;
  endpoint_id: string;
  timestamp: string;
  output_units: number;
  unit_price: number;
  cost_total: number;
  cost_estimate_nano_usd: number;
};

/**
 * Per-request billed costs from `/v1/models/billing-events` — the only
 * source that joins fal's author-reported unit count with the fal-configured
 * unit price into dollars, keyed by the request id our workflows hold.
 * Events lag completion by 1s–5min, so callers should exclude the freshest
 * few minutes.
 */
const BILLING_EVENTS_MAX_ATTEMPTS = 3;
const BILLING_EVENTS_BACKOFF_MS = 2_000;

async function fetchBillingEventsPage(
  billingKey: string,
  url: URL
): Promise<Response> {
  for (let attempt = 1; attempt <= BILLING_EVENTS_MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(url, {
      headers: { Authorization: `Key ${billingKey}` },
    });
    if (
      (resp.status === 429 || resp.status >= 500) &&
      attempt < BILLING_EVENTS_MAX_ATTEMPTS
    ) {
      await sleep(retryAfterMs(resp, attempt, BILLING_EVENTS_BACKOFF_MS));
      continue;
    }
    return resp;
  }
  throw new Error('unreachable');
}

export async function fetchFalBillingEvents(
  billingKey: string,
  start: Date,
  end: Date
): Promise<FalBillingEvent[]> {
  const events: FalBillingEvent[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL('https://api.fal.ai/v1/models/billing-events');
    url.searchParams.set('start', start.toISOString());
    url.searchParams.set('end', end.toISOString());
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetchBillingEventsPage(billingKey, url);
    if (!resp.ok) {
      throw new Error(
        `fal billing-events API HTTP ${resp.status}: ${await resp.text()}`
      );
    }
    const data: {
      billing_events: BillingEventEntry[];
      next_cursor?: string | null;
      has_more?: boolean;
    } = await resp.json();
    for (const e of data.billing_events) {
      events.push({
        requestId: e.request_id,
        endpointId: e.endpoint_id,
        timestamp: e.timestamp,
        outputUnits: e.output_units,
        unitPriceUsd: e.unit_price,
        // nano → micro; fall back to cost_total dollars.
        costMicros: Number.isFinite(e.cost_estimate_nano_usd)
          ? Math.round(e.cost_estimate_nano_usd / 1000)
          : Math.round(e.cost_total * 1_000_000),
      });
    }
    cursor = data.has_more ? (data.next_cursor ?? null) : null;
  } while (cursor);
  return events;
}

// ============================================================================
// Historical per-call cost → typicalUnitsPerCall
// ============================================================================

type EstimateResponse = {
  estimate_type: string;
  total_cost: number;
  currency: string;
};

/**
 * Pacing for `/pricing/estimate`, which fal rate-limits far harder than
 * `/pricing`: measured live, even sequential requests 800ms apart start
 * returning 429 after the third. One at a time, ~1s apart, backoff on 429.
 */
const ESTIMATE_DELAY_MS = 1_000;
const ESTIMATE_MAX_ATTEMPTS = 4;
const ESTIMATE_BACKOFF_MS = 2_000;

/** Honour fal's `Retry-After` (seconds), else exponential backoff. */
function retryAfterMs(
  resp: Response,
  attempt: number,
  backoffMs: number
): number {
  const header = Number(resp.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return backoffMs * 2 ** (attempt - 1);
}

/**
 * "fal has no history" and "we failed to ask" must be handled oppositely: the
 * first is a real absence to record, the second must preserve stored data.
 */
type HistoricalCost =
  | { status: 'ok'; costUsd: number }
  | { status: 'no-history' }
  | { status: 'failed' };

async function fetchHistoricalCostUsd(
  apiKey: string,
  endpointId: string
): Promise<HistoricalCost> {
  for (let attempt = 1; attempt <= ESTIMATE_MAX_ATTEMPTS; attempt++) {
    let body: EstimateResponse;
    try {
      const resp = await fetch(
        'https://api.fal.ai/v1/models/pricing/estimate',
        {
          method: 'POST',
          headers: {
            Authorization: `Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            estimate_type: 'historical_api_price',
            endpoints: { [endpointId]: { call_quantity: 1 } },
          }),
        }
      );
      if (resp.status === 429 && attempt < ESTIMATE_MAX_ATTEMPTS) {
        await sleep(retryAfterMs(resp, attempt, ESTIMATE_BACKOFF_MS));
        continue;
      }
      if (!resp.ok) {
        logger.warn(
          `${endpointId}: historical estimate HTTP ${resp.status} — preserving stored typicalUnitsPerCall`
        );
        return { status: 'failed' };
      }
      // Inside the try: a 200 carrying HTML (CDN error page) must not escape
      // and abort every remaining endpoint.
      body = await resp.json();
    } catch (error) {
      logger.warn(`${endpointId}: historical estimate request failed`, {
        err: error,
      });
      return { status: 'failed' };
    }
    if (!Number.isFinite(body.total_cost) || body.total_cost <= 0) {
      return { status: 'no-history' };
    }
    return { status: 'ok', costUsd: body.total_cost };
  }
  logger.warn(
    `${endpointId}: historical estimate still rate-limited after ${ESTIMATE_MAX_ATTEMPTS} attempts — preserving stored typicalUnitsPerCall`
  );
  return { status: 'failed' };
}

/** Stable precision for typical units (avoids float noise in diffs). */
function roundTypicalUnits(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export type FalTypicalUnits = {
  /** Endpoints fal returned a usable historical cost for. */
  typicalUnits: Map<string, number>;
  /**
   * Endpoints we could not reach — callers must preserve stored values for
   * these. Absent-from-both means fal answered "no history".
   */
  failedEndpoints: Set<string>;
};

/**
 * Fal's historical per-call cost converted to a unit count (cost / unit
 * price). Endpoints with no usage history (total_cost 0 — true for every
 * compute-seconds endpoint we use, #1069) are absent from both outputs.
 */
export async function fetchFalTypicalUnits(
  apiKey: string,
  unitPrices: FalUnitPrice[]
): Promise<FalTypicalUnits> {
  const typicalUnits = new Map<string, number>();
  const failedEndpoints = new Set<string>();
  for (let i = 0; i < unitPrices.length; i++) {
    const price = unitPrices[i];
    if (!price) continue;
    const cost = await fetchHistoricalCostUsd(apiKey, price.endpointId);
    if (cost.status === 'failed') {
      failedEndpoints.add(price.endpointId);
    } else if (cost.status === 'ok') {
      typicalUnits.set(
        price.endpointId,
        roundTypicalUnits(cost.costUsd / price.unitPriceUsd)
      );
    }
    if (i < unitPrices.length - 1) await sleep(ESTIMATE_DELAY_MS);
  }
  return { typicalUnits, failedEndpoints };
}
