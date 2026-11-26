/**
 * What each product model costs today against what its modelschemas card charges (#2432).
 *
 *   bun scripts/gateway-price-parity.ts
 *
 * Cards come from the recorded coverage fixture (no modelschemas calls); fal
 * prices from fal's pricing API (FAL_KEY). The call priced is the coverage
 * check's typical call. Rows that move more than 10% are flagged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchFalUnitPrices } from '@/billing/server/fal-pricing-fetch';
import { BYTEPLUS_RATE_CARD } from '@/billing/byteplus-pricing';
import { microsToUsd } from '@/billing/money';
import {
  SEED_AUDIO_ENDPOINT,
  SEED_SPEECH_RATE_CARD,
} from '@/billing/seed-speech-pricing';
import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import {
  coverageGap,
  modelCoverage,
  recordedModelSchema,
} from '@/gateway/server/coverage';
import { priceGatewayJob } from '@/gateway/server/price';
import { cardParams } from '@modelschemas/rate-card/evaluator';
import {
  geminiImageCost,
  geminiVideoDurationCost,
  nativeGeminiImageModel,
} from '@/models/gemini-native';
import {
  grokImageCost,
  grokVideoDurationCost,
  nativeGrokImageModel,
} from '@/models/grok-native';
import { IMAGE_MODELS } from '@/models/models';
import { typedEntries } from '@/platform/typed-object';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { z } from 'zod';

const FIXTURE = resolve(
  import.meta.dirname,
  '../src/gateway/server/coverage.fixture.json'
);
const models = z
  .array(recordedModelSchema)
  .parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

const falKey = process.env.FAL_KEY;
if (!falKey) throw new Error('FAL_KEY is not set');
const { prices } = await fetchFalUnitPrices(
  falKey,
  models.filter((m) => m.provider === 'fal').map((m) => m.id)
);
const falPrice = new Map(prices.map((p) => [p.endpointId, p]));

function num(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseFloat(String(value));
  return typeof value === 'number' || typeof value === 'string'
    ? Number.isFinite(parsed)
      ? parsed
      : fallback
    : fallback;
}

/** Usage the product assumes for a call, for levers the call's example leaves out (the hold would use the cap). */
const SAMPLE_USAGE: Record<string, number> = { original_duration: 30 };

/** How many of `unit` the call is, read off its params, or null when the unit is not one of these. */
function unitsOf(unit: string, params: Record<string, unknown>): number | null {
  const u = unit.toLowerCase();
  if (u.startsWith('image') || u === 'units') {
    return num(params.num_images ?? params.n, 1);
  }
  if (u.startsWith('second')) {
    return num(params.original_duration ?? params.duration, 5);
  }
  if (u.startsWith('megapixel')) return num(params.megapixels, 1);
  if (u === '1000 tokens') {
    const tokens = params.completion_tokens;
    return typeof tokens === 'number' ? tokens / 1000 : null;
  }
  return null;
}

const imageKeys = typedEntries(IMAGE_MODELS).map(([key]) => key);

/** What the product charges for this call today, in USD, or why it cannot say. */
function productUsd(
  provider: string,
  id: string,
  params: Record<string, unknown>
): number | string {
  const priced = (unit: string, unitPrice: number): number | string => {
    const units = unitsOf(unit, params);
    return units === null ? `unit "${unit}"` : units * unitPrice;
  };
  if (provider === 'fal') {
    const price = falPrice.get(id);
    return price ? priced(price.unit, price.unitPriceUsd) : 'no fal price';
  }
  if (provider === 'byteplus') {
    const row =
      id === SEED_AUDIO_MODEL
        ? SEED_SPEECH_RATE_CARD[SEED_AUDIO_ENDPOINT]
        : BYTEPLUS_RATE_CARD[id];
    if (!row) return 'no product price';
    const units = unitsOf(
      row.unit,
      id === SEED_AUDIO_MODEL
        ? { duration: params.original_duration ?? params.duration }
        : params
    );
    return units === null
      ? `unit "${row.unit}"`
      : units * microsToUsd(row.unitPrice);
  }
  const images = num(params.n ?? params.num_images, 1);
  if (provider === 'grok') {
    const image = imageKeys.map(nativeGrokImageModel).find((m) => m === id);
    return microsToUsd(
      image
        ? grokImageCost(images, image)
        : grokVideoDurationCost(num(params.duration, 5))
    );
  }
  const image = imageKeys.map(nativeGeminiImageModel).find((m) => m === id);
  return microsToUsd(
    image
      ? geminiImageCost(images, image)
      : geminiVideoDurationCost(num(params.duration, 5))
  );
}

const usd = (value: number) => `$${Number(value.toPrecision(4))}`;
console.log('| Model | Call | Card | Today | Move |');
console.log('| --- | --- | --- | --- | --- |');
for (const model of models) {
  const { provider, id } = model;
  const coverage = modelCoverage(model);
  const name = `\`${provider}/${id}\``;
  const gap = coverageGap(coverage);
  const card = rateCardSchema.safeParse(model.record?.pricing);
  if (gap || !coverage.call || !card.success) {
    console.log(`| ${name} | | not held: ${gap} | | |`);
    continue;
  }
  const { request } = coverage.call;
  const usage = { ...coverage.call.usage };
  for (const lever of cardParams(card.data).usage) {
    if (!(lever in usage) && lever in SAMPLE_USAGE) {
      usage[lever] = SAMPLE_USAGE[lever];
    }
  }
  const params = { ...request, ...usage };
  const cardUsd = microsToUsd(priceGatewayJob(card.data, request, usage));
  const today = productUsd(provider, id, params);
  const move =
    typeof today === 'number' && today > 0 ? (cardUsd - today) / today : null;
  const flag = move !== null && Math.abs(move) > 0.1 ? ' **>10%**' : '';
  console.log(
    `| ${name} | \`${JSON.stringify(params)}\` | ${usd(cardUsd)} | ${typeof today === 'number' ? usd(today) : today} | ${move === null ? '' : `${(move * 100).toFixed(0)}%`}${flag} |`
  );
}
