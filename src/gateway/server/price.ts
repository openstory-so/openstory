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
