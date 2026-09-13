import { describe, expect, test } from 'vitest';
import { falCostFromUnits } from '@/billing/server/fal-cost-billing';
import {
  estimateFalCost,
  MIN_OBSERVED_SAMPLES,
  type EffectiveFalPricing,
} from './fal-cost';
import { micros, usdToMicros, ZERO_MICROS } from './money';
import { RATE_CARDS } from './rate-card/cards';
import type { RateCard } from './rate-card/rate-card.schema';

const usd = (n: number) => usdToMicros(n);

/** Fixture mirroring live `model_pricing` rows (raw fal unit strings). */
const PRICING: Record<string, EffectiveFalPricing> = {
  'fal-ai/nano-banana-2': {
    unitPrice: micros(80_000),
    unit: 'images',
    typicalUnitsPerCall: 1.5,
  },
  'fal-ai/flux-2-max': { unitPrice: micros(70_000), unit: 'megapixels' },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': {
    unitPrice: usd(0.49),
    unit: 'units',
    typicalUnitsPerCall: 1,
  },
  'bytedance/seedance-2.5/image-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'fal-ai/elevenlabs/music': { unitPrice: usd(0.8), unit: 'minutes' },
  'fal-ai/veo3.1/image-to-video': { unitPrice: usd(0.4), unit: 'seconds' },
  'openai/gpt-image-2': {
    unitPrice: micros(1_000_000),
    unit: 'units',
    typicalUnitsPerCall: 0.22,
  },
  'xai/grok-imagine-image/quality/text-to-image': {
    unitPrice: micros(170),
    unit: 'compute seconds',
  },
};

describe('falCostFromUnits', () => {
  test('per-image: unitsBilled * unitPrice (resolution premium is in the count)', async () => {
    // nano-banana-2 = $0.08/image. A 2K image fal bills as 1.5 units.
    expect(await falCostFromUnits('fal-ai/nano-banana-2', 1, PRICING)).toBe(
      micros(80_000)
    );
    expect(await falCostFromUnits('fal-ai/nano-banana-2', 1.5, PRICING)).toBe(
      micros(120_000)
    );
  });

  test('per-megapixel: fractional units', async () => {
    expect(await falCostFromUnits('fal-ai/flux-2-max', 1.05, PRICING)).toBe(
      micros(73_500)
    );
  });

  test('flat: hailuo bills 1 unit at $0.49', async () => {
    expect(
      await falCostFromUnits(
        'fal-ai/minimax/hailuo-2.3/pro/image-to-video',
        1,
        PRICING
      )
    ).toBe(usd(0.49));
  });

  test('per-token: seedance bills 1000-token units at $0.014', async () => {
    expect(
      await falCostFromUnits(
        'bytedance/seedance-2.5/image-to-video',
        108,
        PRICING
      )
    ).toBe(micros(1_512_000));
  });

  test('missing unitsBilled charges nothing', async () => {
    expect(
      await falCostFromUnits('fal-ai/nano-banana-2', undefined, PRICING)
    ).toBe(ZERO_MICROS);
  });

  test('unknown endpoint charges nothing', async () => {
    expect(await falCostFromUnits('unknown/model', 5, PRICING)).toBe(
      ZERO_MICROS
    );
  });
});

describe('estimateFalCost', () => {
  test('per-image uses typicalUnitsPerCall × numImages (nano-banana historical 1.5×)', () => {
    // unitPrice $0.08, typicalUnitsPerCall 1.5 → $0.12 each, $0.24 for 2.
    expect(
      estimateFalCost('fal-ai/nano-banana-2', { numImages: 2 }, PRICING)
    ).toBe(micros(240_000));
  });

  test('gpt-image-2 is not estimated at $1/image (unit_price is $1 per unit, ~0.22 units/call)', () => {
    // Treating unitPrice as a flat per-image dollar cost was the #1062 bug.
    expect(
      estimateFalCost('openai/gpt-image-2', { numImages: 1 }, PRICING)
    ).toBe(micros(220_000));
    expect(
      estimateFalCost('openai/gpt-image-2', { numImages: 14 }, PRICING)
    ).toBe(micros(3_080_000));
  });

  test('per-second scales by duration (ignores historical typical duration)', () => {
    expect(
      estimateFalCost(
        'fal-ai/veo3.1/image-to-video',
        { durationSeconds: 8 },
        PRICING
      )
    ).toBe(usd(3.2));
  });

  test('per-second still prefers requested duration over fal typical clip length', () => {
    // fal's historical typical for Veo is an average duration, not a
    // resolution multiplier. Using it would price a 4s clip as 8s.
    const live = {
      'fal-ai/veo3.1/image-to-video': {
        unitPrice: usd(0.4),
        unit: 'seconds',
        typicalUnitsPerCall: 8,
      },
    };
    expect(
      estimateFalCost(
        'fal-ai/veo3.1/image-to-video',
        { durationSeconds: 4 },
        live
      )
    ).toBe(usd(1.6));
  });

  test('H3 Max observed median outranks duration for seconds-priced video', () => {
    const live = {
      'minimax/h3-max/image-to-video': {
        unitPrice: micros(25_000),
        unit: 'seconds',
        observed: { medianUnits: 8, sampleCount: MIN_OBSERVED_SAMPLES },
      },
    };
    expect(
      estimateFalCost(
        'minimax/h3-max/image-to-video',
        { durationSeconds: 5 },
        live
      )
    ).toBe(usd(0.2));
  });

  test('per-minute rounds up', () => {
    expect(
      estimateFalCost(
        'fal-ai/elevenlabs/music',
        { durationSeconds: 61 },
        PRICING
      )
    ).toBe(usd(1.6));
  });

  test('nano-banana-2-lite catalog stub is unknown, not advertised USD', () => {
    // fal's pricing API lists Lite as "units" × $1 with no typicalUnits.
    // Multiplying the stub quotes $1/still; substituting advertised $0.04
    // under-gates ~25× vs a 1-unit bill. Null → gateEstimate $0.10 floor.
    const live = {
      'google/nano-banana-2-lite': {
        unitPrice: micros(1_000_000),
        unit: 'units',
      },
      'google/nano-banana-lite/edit': {
        unitPrice: micros(1_000_000),
        unit: 'units',
      },
    };
    expect(
      estimateFalCost('google/nano-banana-2-lite', { numImages: 1 }, live)
    ).toBeNull();
    expect(
      estimateFalCost('google/nano-banana-lite/edit', { numImages: 1 }, live)
    ).toBeNull();
  });

  test('lite observed median beats the catalog stub', () => {
    const live = {
      'google/nano-banana-2-lite': {
        unitPrice: micros(1_000_000),
        unit: 'units',
        observed: { medianUnits: 0.05, sampleCount: MIN_OBSERVED_SAMPLES },
      },
    };
    expect(
      estimateFalCost('google/nano-banana-2-lite', { numImages: 1 }, live)
    ).toBe(micros(50_000));
  });

  test('lite catalog stub does not change post-generation billing', async () => {
    const live = {
      'google/nano-banana-2-lite': {
        unitPrice: micros(1_000_000),
        unit: 'units',
      },
    };
    expect(await falCostFromUnits('google/nano-banana-2-lite', 1, live)).toBe(
      usd(1)
    );
    expect(
      await falCostFromUnits('google/nano-banana-2-lite', 0.04, live)
    ).toBe(usd(0.04));
  });

  test('compute-seconds with no unit-count signal is unknown, not a fabricated default', () => {
    // The old DEFAULT_COMPUTE_SECONDS=3 made this read ~$0.001 when Grok
    // really bills ~294 compute-seconds (~$0.05) per image (#1069).
    expect(
      estimateFalCost(
        'xai/grok-imagine-image/quality/text-to-image',
        { numImages: 2 },
        PRICING
      )
    ).toBeNull();
  });

  test('compute-seconds uses observed median units when the live table has them', () => {
    // ~294 compute-seconds/image at $0.00017 ≈ $0.05 — Grok's real price.
    const live = {
      'xai/grok-imagine-image/quality/text-to-image': {
        unitPrice: micros(170),
        unit: 'compute seconds',
        observed: { medianUnits: 294, sampleCount: MIN_OBSERVED_SAMPLES },
      },
    };
    expect(
      estimateFalCost(
        'xai/grok-imagine-image/quality/text-to-image',
        { numImages: 2 },
        live
      )
    ).toBe(micros(99_960));
  });

  test('observed median units beat fal historical when both exist', () => {
    const live = {
      'fal-ai/nano-banana-2': {
        unitPrice: micros(80_000),
        unit: 'images',
        typicalUnitsPerCall: 1.5,
        observed: { medianUnits: 1, sampleCount: MIN_OBSERVED_SAMPLES },
      },
    };
    expect(
      estimateFalCost('fal-ai/nano-banana-2', { numImages: 2 }, live)
    ).toBe(micros(160_000));
  });

  test('an under-sampled observed median does not outrank fal historical', () => {
    // One anomalous generation must not become the platform-wide gate (#1069).
    const live = {
      'fal-ai/nano-banana-2': {
        unitPrice: micros(80_000),
        unit: 'images',
        typicalUnitsPerCall: 1.5,
        observed: { medianUnits: 0.01, sampleCount: 1 },
      },
    };
    expect(
      estimateFalCost('fal-ai/nano-banana-2', { numImages: 2 }, live)
    ).toBe(micros(240_000));
  });

  test('an under-sampled median on a compute-seconds model stays unknown', () => {
    const live = {
      'xai/grok-imagine-image/quality/text-to-image': {
        unitPrice: micros(170),
        unit: 'compute seconds',
        observed: { medianUnits: 294, sampleCount: MIN_OBSERVED_SAMPLES - 1 },
      },
    };
    expect(
      estimateFalCost(
        'xai/grok-imagine-image/quality/text-to-image',
        { numImages: 1 },
        live
      )
    ).toBeNull();
  });

  test('a catalog unit we have no strategy for estimates per call', () => {
    // Catalog-wide refresh stores raw units like "videos" or "5 seconds" —
    // these estimate from observed/typical units, or report unknown.
    const live = {
      'some/video-model': {
        unitPrice: usd(0.3),
        unit: 'videos',
        typicalUnitsPerCall: 1,
      },
      'some/other-model': { unitPrice: usd(0.1), unit: '5 seconds' },
    };
    expect(estimateFalCost('some/video-model', {}, live)).toBe(usd(0.3));
    expect(estimateFalCost('some/other-model', {}, live)).toBeNull();
  });

  test('unknown endpoint has no estimate', () => {
    expect(
      estimateFalCost('unknown/model', { numImages: 1 }, PRICING)
    ).toBeNull();
  });
});

describe('estimateFalCost with a rate card (#1605)', () => {
  const H3 = 'minimax/h3-max/image-to-video';
  const h3Card = (): RateCard => {
    const card = RATE_CARDS[H3];
    if (!card) throw new Error('no H3 Max hand card');
    return card;
  };
  const carded = (
    overrides: Partial<EffectiveFalPricing> = {}
  ): Record<string, EffectiveFalPricing> => ({
    [H3]: {
      unitPrice: micros(25_000),
      unit: 'seconds',
      observed: { medianUnits: 8, sampleCount: MIN_OBSERVED_SAMPLES },
      rateCard: { card: h3Card(), verified: true },
      ...overrides,
    },
  });
  const request = { duration: 5, resolution: '1080P' };

  test('a verified card prices the request it is handed, ahead of every unit count', () => {
    // 1080P 5s off the page's per-second row; the observed 8 units × $0.025
    // would have said $0.20 whatever the resolution.
    expect(estimateFalCost(H3, { durationSeconds: 5, request }, carded())).toBe(
      usd(0.2)
    );
    expect(
      estimateFalCost(
        H3,
        { durationSeconds: 5, request: { duration: 5, resolution: '480P' } },
        carded()
      )
    ).toBe(usd(0.0625));
  });

  test('calibration multiplies the card once enough observations back it', () => {
    // The reconcile measured fal billing 1.6× what the card says.
    expect(
      estimateFalCost(
        H3,
        { durationSeconds: 5, request },
        carded({
          rateCardCalibration: {
            ratio: 1.6,
            sampleCount: MIN_OBSERVED_SAMPLES,
          },
        })
      )
    ).toBe(usd(0.32));
    expect(
      estimateFalCost(
        H3,
        { durationSeconds: 5, request },
        carded({
          rateCardCalibration: {
            ratio: 1.6,
            sampleCount: MIN_OBSERVED_SAMPLES - 1,
          },
        })
      )
    ).toBe(usd(0.2));
  });

  test('no request → the card is skipped, not priced at its defaults', () => {
    // Observed 8 units outrank the 5s duration on the seconds path.
    expect(estimateFalCost(H3, { durationSeconds: 5 }, carded())).toBe(
      usd(0.2)
    );
    expect(
      estimateFalCost(
        H3,
        { durationSeconds: 10 },
        carded({ observed: undefined })
      )
    ).toBe(usd(0.25));
  });

  test('an unverified or expired card falls through to the unit counts', () => {
    const unverified = carded({
      rateCard: { card: h3Card(), verified: false },
    });
    expect(
      estimateFalCost(H3, { durationSeconds: 5, request }, unverified)
    ).toBe(usd(0.2));
    const expired = carded({
      rateCard: {
        card: {
          ...h3Card(),
          source: { ...h3Card().source, expiresAt: '2020-01-01T00:00:00Z' },
        },
        verified: true,
      },
    });
    expect(estimateFalCost(H3, { durationSeconds: 5, request }, expired)).toBe(
      usd(0.2)
    );
  });

  test('a request the card refuses falls through rather than inventing a tier', () => {
    expect(
      estimateFalCost(
        H3,
        { durationSeconds: 5, request: { duration: 5, resolution: '4K' } },
        carded()
      )
    ).toBe(usd(0.2));
  });

  test('a card on a catalog stub is the estimate the stub never had', () => {
    // GPT Image 2.5 day one: "units" × $1, no history, no samples — null
    // before; the size × quality table now prices the default request.
    const GPT = 'openai/gpt-image-2.5/flare/text-to-image';
    const card = RATE_CARDS[GPT];
    if (!card) throw new Error('no GPT hand card');
    const live = {
      [GPT]: {
        unitPrice: micros(1_000_000),
        unit: 'units',
        rateCard: { card, verified: true },
      },
    };
    expect(estimateFalCost(GPT, { numImages: 1 }, live)).toBeNull();
    expect(
      estimateFalCost(
        GPT,
        { numImages: 2, request: { num_images: 2, quality: 'high' } },
        live
      )
    ).toBe(usd(0.07224));
  });
});
