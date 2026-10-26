/**
 * Pull modelschemas rate cards for the fal endpoints we use (#1605).
 *
 * The daily pricing refresh stores the card. Estimation reads that copy.
 * A missing card or a failed fetch is a warn and an empty slot — the caller
 * keeps the card it already stored. There is no runtime call on the gate.
 */

import { getEnv } from '#env';
import { rateCardSchema } from '@modelschemas/rate-card';
import type { RateCard } from '@modelschemas/rate-card/evaluator';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'billing', 'rate-cards']);

const MODELSCHEMAS_BASE_URL = 'https://modelschemas.com';

export async function fetchFalRateCards(
  endpointIds: string[]
): Promise<Map<string, RateCard>> {
  const env = getEnv();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.MODELSCHEMAS_API_KEY) {
    headers.Authorization = `Bearer ${env.MODELSCHEMAS_API_KEY}`;
  }

  const cards = new Map<string, RateCard>();
  for (const endpointId of endpointIds) {
    const card = await fetchOne(endpointId, headers);
    if (card) cards.set(endpointId, card);
  }
  return cards;
}

async function fetchOne(
  endpointId: string,
  headers: Record<string, string>
): Promise<RateCard | undefined> {
  const url = `${MODELSCHEMAS_BASE_URL}/v1/models/fal/${encodeURIComponent(endpointId)}`;
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    logger.warn(
      'modelschemas rate card fetch failed — keeping the stored card',
      {
        endpointId,
        err,
      }
    );
    return undefined;
  }
  if (!response.ok) {
    logger.warn(
      'modelschemas has no rate card for this endpoint — keeping the stored card',
      {
        endpointId,
        status: response.status,
      }
    );
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    logger.warn(
      'modelschemas rate card response was not JSON — keeping the stored card',
      {
        endpointId,
        err,
      }
    );
    return undefined;
  }

  const pricing =
    body !== null && typeof body === 'object' && 'pricing' in body
      ? body.pricing
      : undefined;
  const parsed = rateCardSchema.safeParse(pricing);
  if (!parsed.success) {
    logger.warn(
      'modelschemas pricing is not a rate card — keeping the stored card',
      {
        endpointId,
      }
    );
    return undefined;
  }
  return parsed.data;
}
