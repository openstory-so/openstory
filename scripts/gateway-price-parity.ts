/**
 * What each product model costs today against what its modelschemas card holds (#2432).
 *
 *   bun scripts/gateway-price-parity.ts
 *
 * No network. Cards come from the recorded coverage fixture. The call priced is
 * the body the product's own builder sends (`coverage-bodies.ts`: 5 s, 16:9,
 * the builder's default resolution and audio), else the card's typical call.
 * "Today" is what the product charges for that call:
 *   fal: `estimateFalCost` on production-shaped `model_pricing` rows
 *     (`LOCAL_FAL_PRICING_SEED` with its typical and billed-unit counts, no
 *     stored card), which is fal's unit price times the units fal bills;
 *   BytePlus, Seed Audio, Grok, Gemini: the static tables the product bills from.
 * "Card charge" is the card at that call's usage (5 s, the output megapixels);
 * "Hold" is what the gateway reserves before it knows the usage. Rows whose
 * charge moves more than 10% from today are flagged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BYTEPLUS_RATE_CARD } from '@/billing/byteplus-pricing';
import { estimateFalCost } from '@/billing/fal-cost';
import { microsToUsd, usdToMicros } from '@/billing/money';
import {
  SEED_AUDIO_ENDPOINT,
  SEED_SPEECH_RATE_CARD,
} from '@/billing/seed-speech-pricing';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { LOCAL_FAL_PRICING_SEED } from '@/billing/server/seed-model-pricing';
import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import { productBodies } from '@/gateway/server/coverage-bodies';
import {
  coverageGap,
  modelCoverage,
  recordedModelSchema,
} from '@/gateway/server/coverage';
import { priceGatewayJob } from '@/gateway/server/price';
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
const bodies = productBodies();

const falPricing: Record<string, EffectiveFalPricing> = Object.fromEntries(
  Object.entries(LOCAL_FAL_PRICING_SEED).map(([id, seed]) => [
    id,
    {
      unit: seed.unit,
      unitPrice: usdToMicros(seed.unitPriceUsd),
      typicalUnitsPerCall: seed.typicalUnitsPerCall,
    },
  ])
);

// fal's own pixel sizes for the presets the builders send.
const PRESET_PIXELS: Record<string, [number, number]> = {
  landscape_16_9: [1024, 576],
  portrait_16_9: [576, 1024],
  square_hd: [1024, 1024],
};

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Seconds a call runs, as the product sends it (fal spells it as a string). */
function seconds(params: Record<string, unknown>): number {
  const raw = params.original_duration ?? params.duration;
  return num(typeof raw === 'string' ? Number(raw) : raw, 5);
}

/** The output size a still asks for, when it says. */
function pixels(body: Record<string, unknown>): [number, number] | undefined {
  const size = body.image_size;
  if (typeof size === 'string') return PRESET_PIXELS[size];
  const dims = z
    .object({ width: z.number(), height: z.number() })
    .safeParse(size).data;
  return dims && [dims.width, dims.height];
}

/** The usage the call reports, under every name a card spells it: the clip length and the output megapixels. */
function productUsage(params: Record<string, unknown>): Record<string, number> {
  const length = seconds(params);
  const size = pixels(params);
  const megapixels = size && (size[0] * size[1]) / 1_000_000;
  return {
    duration: length,
    original_duration: length,
    seconds: length,
    ...(megapixels && {
      megapixels,
      mp_output: megapixels,
      output_megapixels: megapixels,
    }),
  };
}

function falToday(id: string, body: Record<string, unknown>): number | string {
  const [widthPx, heightPx] = pixels(body) ?? [undefined, undefined];
  const duration = seconds(body);
  const cost = estimateFalCost(
    id,
    {
      request: body,
      usage: { duration },
      numImages: num(body.num_images, 1),
      durationSeconds: duration,
      resolution:
        typeof body.resolution === 'string' ? body.resolution : undefined,
      widthPx,
      heightPx,
    },
    falPricing
  );
  return cost === null ? 'no estimate' : microsToUsd(cost);
}

const imageKeys = typedEntries(IMAGE_MODELS).map(([key]) => key);

/** What the product charges for this call today, in USD, and where that number comes from. */
function today(
  provider: string,
  id: string,
  params: Record<string, unknown>
): { usd: number | string; source: string } {
  if (provider === 'fal') {
    return {
      usd: falToday(id, params),
      source: 'seed-model-pricing.ts',
    };
  }
  if (provider === 'byteplus') {
    const audio = id === SEED_AUDIO_MODEL;
    const row = audio
      ? SEED_SPEECH_RATE_CARD[SEED_AUDIO_ENDPOINT]
      : BYTEPLUS_RATE_CARD[id];
    const source = audio ? 'seed-speech-pricing.ts' : 'byteplus-pricing.ts';
    if (!row) return { usd: 'no product price', source };
    const unit = row.unit.toLowerCase();
    const units = unit.startsWith('second')
      ? seconds(params)
      : unit.startsWith('image')
        ? num(params.n, 1)
        : null;
    return {
      usd:
        units === null
          ? `unit "${row.unit}"`
          : units * microsToUsd(row.unitPrice),
      source,
    };
  }
  const images = num(params.n ?? params.num_images, 1);
  if (provider === 'grok') {
    const image = imageKeys.map(nativeGrokImageModel).find((m) => m === id);
    return {
      usd: microsToUsd(
        image
          ? grokImageCost(images, image)
          : grokVideoDurationCost(seconds(params))
      ),
      source: 'grok-native.ts',
    };
  }
  const image = imageKeys.map(nativeGeminiImageModel).find((m) => m === id);
  return {
    usd: microsToUsd(
      image
        ? geminiImageCost(images, image)
        : geminiVideoDurationCost(seconds(params))
    ),
    source: 'gemini-native.ts',
  };
}

const usd = (value: number) => `$${Number(value.toPrecision(4))}`;
const moved: string[] = [];
console.log('| Model | Call | Hold | Card charge | Today | Source | Move |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const model of models) {
  const { provider, id } = model;
  const name = `\`${provider}/${id}\``;
  const body = bodies.get(`${provider}/${id}`);
  const coverage = modelCoverage(model, body);
  const card = rateCardSchema.safeParse(model.record?.pricing);
  const gap = coverageGap(coverage);
  if (!card.success || !coverage.call || (gap && !body)) {
    console.log(`| ${name} | | not held: ${gap} | | | | |`);
    continue;
  }
  const request = body ?? coverage.call.request;
  const call = body ? 'product body' : 'typical';
  const params = { ...request, ...coverage.call.usage };
  const usage = {
    ...productUsage(params),
    ...(body ? {} : coverage.call.usage),
  };
  let holdUsd: number;
  let cardUsd: number;
  try {
    holdUsd = microsToUsd(priceGatewayJob(card.data, request));
    cardUsd = microsToUsd(priceGatewayJob(card.data, request, usage));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`| ${name} | ${call} | refused: ${reason} | | | | |`);
    continue;
  }
  const { usd: now, source } = today(provider, id, body ?? params);
  const move =
    typeof now === 'number' && now > 0 ? (cardUsd - now) / now : null;
  const flagged = move !== null && Math.abs(move) > 0.1;
  if (flagged) moved.push(`${name} ${(move * 100).toFixed(0)}%`);
  console.log(
    `| ${name} | ${call} | ${usd(holdUsd)} | ${usd(cardUsd)} | ${typeof now === 'number' ? usd(now) : now} | ${source} | ${move === null ? '' : `${(move * 100).toFixed(0)}%`}${flagged ? ' **>10%**' : ''} |`
  );
}
console.log(`\n${moved.length} rows move more than 10%: ${moved.join(', ')}`);
