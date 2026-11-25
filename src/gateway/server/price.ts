/** A gateway job's price: the model's rate card worked out against the request and, once known, the usage. */

import { type Microdollars, usdToMicros } from '@/billing/money';
import type { GatewayJobInput } from '@/gateway/schema';
import {
  cardParams,
  evaluateCard,
  normalizeUsage,
  RateCardError,
  type RateCard,
} from '@modelschemas/rate-card/evaluator';

// ponytail: a name list, not the card. Drop it when every card prices its own count lever.
export const COUNT_FIELDS = [
  'n',
  'num_images',
  'num_outputs',
  'num_videos',
  'number_of_images',
  'sample_count',
  'max_images',
  'candidateCount',
  'candidate_count',
];

/** The first count field at any depth under `value` whose count is `refused`. */
export function countFieldWhere(
  value: unknown,
  refused: (count: unknown) => boolean
): string | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => countFieldWhere(item, refused)).find(Boolean);
  }
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (COUNT_FIELDS.includes(key) && refused(inner)) return key;
    const found = countFieldWhere(inner, refused);
    if (found) return found;
  }
  return undefined;
}

/** How many outputs the hold covers: the request's own count, else one. */
export function heldOutputs(request: GatewayJobInput): number {
  const counts = COUNT_FIELDS.map((field) => request[field]).filter(
    (count): count is number => typeof count === 'number'
  );
  return Math.max(1, ...counts);
}

/** The card's own levers, picked by name out of a usage object that carries other counts too. */
function namedLevers(
  card: RateCard,
  usage: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    cardParams(card)
      .usage.filter((lever) => lever in usage)
      .map((lever) => [lever, usage[lever]])
  );
}

function evaluate(
  card: RateCard,
  request: GatewayJobInput,
  usage?: Record<string, unknown>
): Microdollars {
  const { amount, currency } = evaluateCard(card, {
    request,
    ...(usage && { usage }),
  });
  if (currency !== 'USD') {
    throw new Error(`Rate card is in ${currency}, not USD`);
  }
  return usdToMicros(amount);
}

/** Throws `RateCardError` when the card cannot price this request: a refusal, never a guess. */
export function priceGatewayJob(
  card: RateCard,
  request: GatewayJobInput,
  usage?: Record<string, unknown> | null
): Microdollars {
  if (!usage || cardParams(card).usage.length === 0) {
    return evaluate(card, request);
  }
  try {
    // First as the provider sent it, so cached and reasoning counts are split out.
    return evaluate(card, request, normalizeUsage(card, usage));
  } catch (error) {
    const extraKeys =
      error instanceof RateCardError &&
      (error.code === 'unknown-usage-key' || error.code === 'mixed-usage');
    if (!extraKeys) throw error;
    // Ark and xAI report totals the card does not read beside the levers it does.
    return evaluate(card, request, namedLevers(card, usage));
  }
}
