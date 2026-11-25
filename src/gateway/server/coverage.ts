/** Can the gateway hold and charge each product model from its card? (#2432, `scripts/check-gateway-coverage.ts`) */

import { GATEWAY_PROVIDERS, type GatewayProvider } from '@/gateway/schema';
import { priceGatewayJob } from '@/gateway/server/price';
import { cardParams, type RateCard } from '@modelschemas/rate-card/evaluator';
import type { JsonValue } from '@/platform/server/db/schema';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { z } from 'zod';

/** What modelschemas answered for one model, as recorded. */
export const recordedModelSchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  id: z.string(),
  /** Null where modelschemas has no such model. */
  record: z
    .object({
      activity: z.string().nullable(),
      schemaEndpointId: z.string().nullable(),
      pricing: z.unknown(),
    })
    .nullable(),
  /** Whether the request schema the record names loads. */
  schema: z.boolean(),
});
export type RecordedModel = z.infer<typeof recordedModelSchema>;

export type Coverage = {
  provider: GatewayProvider;
  id: string;
  found: boolean;
  schema: boolean;
  card: boolean;
  /** Why the card cannot hold a typical request, or null. */
  hold: string | null;
  /** Why the card cannot charge a typical usage, or null. */
  charge: string | null;
};

function failure(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A typical call: the card's own first example, split into its request fields and its usage levers. */
export function typicalCall(card: RateCard): {
  request: Record<string, JsonValue>;
  usage: Record<string, unknown>;
} {
  const levers = new Set(cardParams(card).usage);
  const params = Object.entries(card.examples[0]?.params ?? {});
  return {
    request: Object.fromEntries(
      params.flatMap(([key, value]) => {
        const json = z.json().safeParse(value);
        return !levers.has(key) && json.success ? [[key, json.data]] : [];
      })
    ),
    usage: Object.fromEntries(params.filter(([key]) => levers.has(key))),
  };
}

export function modelCoverage(model: RecordedModel): Coverage {
  const { provider, id, record, schema } = model;
  const parsed = rateCardSchema.safeParse(record?.pricing);
  const base = { provider, id, found: record !== null, schema };
  if (!parsed.success) {
    const reason = record ? 'no rate card' : 'not on modelschemas';
    return { ...base, card: false, hold: reason, charge: reason };
  }
  const card = parsed.data;
  const { request, usage } = typicalCall(card);
  return {
    ...base,
    card: true,
    hold: failure(() => priceGatewayJob(card, request)),
    charge: failure(() => priceGatewayJob(card, request, usage)),
  };
}

/** The first thing that stops the gateway serving this model, or null. */
export function coverageGap(coverage: Coverage): string | null {
  if (!coverage.found) return 'not on modelschemas';
  if (!coverage.schema) return 'request schema does not load';
  return coverage.hold ?? coverage.charge;
}

/** Gaps the doc does not list, each on a line naming the model and its upstream issue. */
export function unlistedGaps(
  coverages: readonly Coverage[],
  doc: string
): Coverage[] {
  const lines = doc.split('\n');
  return coverages.filter(
    (coverage) =>
      coverageGap(coverage) !== null &&
      !lines.some(
        (line) =>
          line.includes(`\`${coverage.provider}/${coverage.id}\``) &&
          /TanStack\/schemas#\d+/.test(line)
      )
  );
}
