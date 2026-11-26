/** Can the gateway hold and charge each product model from its card? (#2432, `scripts/check-gateway-coverage.ts`) */

import { GATEWAY_PROVIDERS, type GatewayProvider } from '@/gateway/schema';
import { priceGatewayJob } from '@/gateway/server/price';
import {
  cardParams,
  RateCardError,
  type RateCard,
} from '@modelschemas/rate-card/evaluator';
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
      rawId: z.string(),
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
  /** The id modelschemas answers under; the snapshot keeps only a model answering under its own. */
  answersAs: string;
  schema: boolean;
  card: boolean;
  /** Why the card cannot hold a typical request, or null. */
  hold: string | null;
  /** Why the card cannot charge a typical usage, or null. */
  charge: string | null;
  /** The typical call priced, when there is a card. */
  call: {
    request: Record<string, JsonValue>;
    usage: Record<string, unknown>;
  } | null;
};

/** A typical call: the card's own first example, split into its request fields and its usage levers. */
function typicalCall(card: RateCard): {
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

const inputDefSchema = z.object({
  param: z.string(),
  kind: z.string(),
  bound: z.string().optional(),
  estimate: z.unknown().optional(),
  values: z.array(z.string()).optional(),
  levels: z.array(z.string()).optional(),
});

/** The input named `name` in the card's own inputs or any lever's estimate inputs. */
function inputDef(
  value: unknown,
  name: string
): z.infer<typeof inputDefSchema> | null {
  if (value === null || typeof value !== 'object') return null;
  const inputs = z
    .object({ inputs: z.record(z.string(), z.unknown()) })
    .safeParse(value);
  const own = inputDefSchema.safeParse(inputs.data?.inputs[name]);
  if (own.success) return own.data;
  for (const inner of Object.values(value)) {
    const found = inputDef(inner, name);
    if (found) return found;
  }
  return null;
}

/** A value a product request would carry for a request field the card needs. */
function sampleValue(def: z.infer<typeof inputDefSchema>): JsonValue {
  switch (def.kind) {
    case 'enum':
      return def.values?.[0] ?? null;
    case 'dimensions':
      return def.levels?.[0] ?? '1024x1024';
    case 'boolean':
      return false;
    case 'count':
      return [];
    default:
      return 5;
  }
}

/**
 * The hold for a typical request: the card's first example, plus a value for
 * each request field the card says it needs. A usage lever with no estimate
 * is a real gap and is never filled.
 */
function holdFailure(
  card: RateCard,
  request: Record<string, JsonValue>
): { failure: string | null; request: Record<string, JsonValue> } {
  const filled = { ...request };
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      priceGatewayJob(card, filled);
      return { failure: null, request: filled };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof RateCardError ? error.input : undefined;
      const def = name ? inputDef(card, name) : null;
      if (!def || def.bound === 'usage' || def.param in filled) {
        return { failure: message, request: filled };
      }
      filled[def.param] = sampleValue(def);
    }
  }
  return { failure: 'too many required fields', request: filled };
}

export function modelCoverage(model: RecordedModel): Coverage {
  const { provider, id, record, schema } = model;
  const parsed = rateCardSchema.safeParse(record?.pricing);
  const base = {
    provider,
    id,
    found: record !== null,
    answersAs: record?.rawId ?? id,
    schema,
  };
  if (!parsed.success) {
    const reason = record ? 'no rate card' : 'not on modelschemas';
    return { ...base, card: false, hold: reason, charge: reason, call: null };
  }
  const card = parsed.data;
  const typical = typicalCall(card);
  const { failure, request } = holdFailure(card, typical.request);
  return {
    ...base,
    card: true,
    hold: failure,
    charge: failure ?? chargeFailure(card, request, typical.usage),
    call: { request, usage: typical.usage },
  };
}

function chargeFailure(
  card: RateCard,
  request: Record<string, JsonValue>,
  usage: Record<string, unknown>
): string | null {
  try {
    priceGatewayJob(card, request, usage);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first thing that stops the gateway serving this model, or null. */
export function coverageGap(coverage: Coverage): string | null {
  if (!coverage.found) return 'not on modelschemas';
  if (coverage.answersAs !== coverage.id) {
    return `modelschemas answers as ${coverage.answersAs}`;
  }
  if (!coverage.schema) return 'request schema does not load';
  return coverage.hold ?? coverage.charge;
}

/** Gaps the doc does not list: a gap's paragraph names the model and its upstream issue, or `not yet filed`. */
export function unlistedGaps(
  coverages: readonly Coverage[],
  doc: string
): Coverage[] {
  const paragraphs = doc.split(/\n(?=- )|\n\n/);
  return coverages.filter(
    (coverage) =>
      coverageGap(coverage) !== null &&
      !paragraphs.some(
        (paragraph) =>
          paragraph.includes(`\`${coverage.provider}/${coverage.id}\``) &&
          /TanStack\/schemas#\d+|not yet filed/.test(paragraph)
      )
  );
}
