import { describe, expect, test } from 'vitest';
import {
  estimateFalCost,
  falCostFromUnits,
  MIN_OBSERVED_SAMPLES,
  type EffectiveFalPricing,
} from './fal-cost';
import { micros, usdToMicros, ZERO_MICROS } from '@/lib/billing/money';

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

  test('H3 Max 5s clip estimates 8 units at the billed 480p-second rate', () => {
    // 768P default bills 1.6× the stored $0.025 unit → 8 units × $0.025 = $0.20.
    // Using duration (5) as units was 37% low (#1382).
    const live = {
      'minimax/h3-max/image-to-video': {
        unitPrice: micros(25_000),
        unit: 'seconds',
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

  test('H3 Max scales the 5s typical with requested duration', () => {
    const live = {
      'minimax/h3-max/image-to-video': {
        unitPrice: micros(25_000),
        unit: 'seconds',
        typicalUnitsPerCall: 8,
      },
    };
    expect(
      estimateFalCost(
        'minimax/h3-max/image-to-video',
        { durationSeconds: 10 },
        live
      )
    ).toBe(usd(0.4));
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

  test('H3 Max t2v compute-seconds still has a unit-count signal', () => {
    // Before the sibling alias copies i2v's verified rate, t2v sat on
    // "compute seconds × $0.00017" and logged "No unit-count signal".
    const live = {
      'minimax/h3-max/text-to-video': {
        unitPrice: micros(170),
        unit: 'compute seconds',
      },
    };
    expect(
      estimateFalCost(
        'minimax/h3-max/text-to-video',
        { durationSeconds: 5 },
        live
      )
    ).not.toBeNull();
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

  test('tokens estimate uses 720p default (Seedance platform default, not 1080p)', () => {
    // tokens = 1280×720×24×5 / 1024 = 108_000 → 108 × 1.05 units × $0.014
    const expected720p = micros(1_587_600);
    expect(
      estimateFalCost(
        'bytedance/seedance-2.5/image-to-video',
        { durationSeconds: 5 },
        PRICING
      )
    ).toBe(expected720p);
    expect(
      estimateFalCost(
        'bytedance/seedance-2.5/image-to-video',
        { durationSeconds: 5, resolution: '720p' },
        PRICING
      )
    ).toBe(expected720p);
  });

  test('tokens estimate scales with explicit 1080p resolution', () => {
    // 1080p pixel area is 2.25× 720p → cost scales the same way
    const at1080 = Number(
      estimateFalCost(
        'bytedance/seedance-2.5/image-to-video',
        { durationSeconds: 5, resolution: '1080p' },
        PRICING
      )
    );
    const at720 = Number(
      estimateFalCost(
        'bytedance/seedance-2.5/image-to-video',
        { durationSeconds: 5, resolution: '720p' },
        PRICING
      )
    );
    expect(at1080 / at720).toBeCloseTo((1920 * 1080) / (1280 * 720), 5);
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
