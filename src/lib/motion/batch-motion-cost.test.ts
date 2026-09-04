import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from './batch-motion-cost';
import { estimateVideoCost, gateEstimate } from '@/lib/billing/cost-estimation';
import { addMicros, micros, ZERO_MICROS } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/snap-duration';

const sequence = { videoModel: 'minimax_hailuo_02' };
// `video_variants.model` of each shot's selected version (#1066).
const shotModels = {
  selected: new Map([
    ['shot-a', 'seedance_v2'],
    ['shot-b', 'kling_v3_pro'],
  ]),
  lastFailed: new Map<string, string>(),
};

describe('resolveBatchShotVideoModel', () => {
  it('prefers the explicit batch model over the selected version and sequence', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        shotModels,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });

  it("resolves the shot's selected video version model when no explicit model", () => {
    expect(
      resolveBatchShotVideoModel({ id: 'shot-a' }, shotModels, sequence)
    ).toBe('seedance_v2');
  });

  it('falls back to the sequence default when the shot has no selected version', () => {
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-never-rendered' },
        shotModels,
        sequence
      )
    ).toBe('minimax_hailuo_02');
  });

  it("prefers a failed attempt's model over the older selected version", () => {
    // shot-a's last render failed on veo3_1; re-running the batch must retry
    // that model, not silently fall back to the selected seedance_v2.
    const withFailure = {
      selected: shotModels.selected,
      lastFailed: new Map([['shot-a', 'veo3_1']]),
    };
    expect(
      resolveBatchShotVideoModel({ id: 'shot-a' }, withFailure, sequence)
    ).toBe('veo3_1');
    // Shots without a failure are untouched.
    expect(
      resolveBatchShotVideoModel({ id: 'shot-b' }, withFailure, sequence)
    ).toBe('kling_v3_pro');
  });

  it('still lets an explicit batch model override a failed attempt', () => {
    const withFailure = {
      selected: shotModels.selected,
      lastFailed: new Map([['shot-a', 'veo3_1']]),
    };
    expect(
      resolveBatchShotVideoModel(
        { id: 'shot-a' },
        withFailure,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });
});

/** Unequal Seedance i2v vs ref rates so routing regressions fail the suite. */
const seedanceUnequalPricing = {
  ...FAL_PRICING,
  'bytedance/seedance-2.5/image-to-video': {
    unitPrice: micros(10_000),
    unit: 'units',
  },
  'bytedance/seedance-2.5/reference-to-video': {
    unitPrice: micros(20_000),
    unit: 'units',
  },
};

describe('estimateBatchMotionCost', () => {
  it('prices Seedance at reference-to-video when hasReferenceImages is true', () => {
    const shots = [{ id: 'shot-a' }];
    const seedanceOnly = {
      selected: new Map([['shot-a', 'seedance_v2_5']]),
      lastFailed: new Map<string, string>(),
    };
    const i2v = estimateBatchMotionCost(shots, seedanceOnly, sequence, {
      pricing: seedanceUnequalPricing,
      hasReferenceImages: false,
    });
    const ref = estimateBatchMotionCost(shots, seedanceOnly, sequence, {
      pricing: seedanceUnequalPricing,
      hasReferenceImages: true,
    });
    expect(Number(ref)).toBeGreaterThan(Number(i2v));
  });

  it('supports per-shot hasReferenceImages functions', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const seedanceBoth = {
      selected: new Map([
        ['shot-a', 'seedance_v2_5'],
        ['shot-b', 'seedance_v2_5'],
      ]),
      lastFailed: new Map<string, string>(),
    };
    const mixed = estimateBatchMotionCost(shots, seedanceBoth, sequence, {
      pricing: seedanceUnequalPricing,
      hasReferenceImages: (shot) => shot.id === 'shot-a',
    });
    const bothI2v = estimateBatchMotionCost(shots, seedanceBoth, sequence, {
      pricing: seedanceUnequalPricing,
      hasReferenceImages: false,
    });
    const bothRef = estimateBatchMotionCost(shots, seedanceBoth, sequence, {
      pricing: seedanceUnequalPricing,
      hasReferenceImages: true,
    });
    expect(Number(mixed)).toBeGreaterThan(Number(bothI2v));
    expect(Number(mixed)).toBeLessThan(Number(bothRef));
  });

  it('leaves Kling on i2v when hasReferenceImages is true', () => {
    const shots = [{ id: 'shot-b' }];
    const withRefs = estimateBatchMotionCost(shots, shotModels, sequence, {
      pricing: FAL_PRICING,
      hasReferenceImages: true,
    });
    const without = estimateBatchMotionCost(shots, shotModels, sequence, {
      pricing: FAL_PRICING,
      hasReferenceImages: false,
    });
    expect(withRefs).toEqual(without);
  });

  it('sums per-shot cost across shots rendered by different (priced) models', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const expected = addMicros(
      addMicros(
        ZERO_MICROS,
        gateEstimate(
          estimateVideoCost(
            'seedance_v2',
            snapDuration(undefined, 'seedance_v2'),
            { pricing: FAL_PRICING }
          ),
          { model: 'seedance_v2', operation: 'batch-motion' }
        )
      ),
      gateEstimate(
        estimateVideoCost(
          'kling_v3_pro',
          snapDuration(undefined, 'kling_v3_pro'),
          { pricing: FAL_PRICING }
        ),
        { model: 'kling_v3_pro', operation: 'batch-motion' }
      )
    );
    expect(
      estimateBatchMotionCost(shots, shotModels, sequence, {
        pricing: FAL_PRICING,
      })
    ).toEqual(expected);
  });

  it('prices every shot with the explicit batch model when given', () => {
    const shots = [{ id: 'shot-a' }, { id: 'shot-b' }];
    const perShot = gateEstimate(
      estimateVideoCost('kling_v3_pro', snapDuration(5, 'kling_v3_pro'), {
        pricing: FAL_PRICING,
      }),
      { model: 'kling_v3_pro', operation: 'batch-motion' }
    );
    const expected = addMicros(addMicros(ZERO_MICROS, perShot), perShot);
    expect(
      estimateBatchMotionCost(shots, shotModels, sequence, {
        pricing: FAL_PRICING,
        explicitModel: 'kling_v3_pro',
        duration: 5,
      })
    ).toEqual(expected);
  });

  it('is ZERO for an empty shot list', () => {
    expect(
      estimateBatchMotionCost([], shotModels, sequence, {
        pricing: FAL_PRICING,
      })
    ).toEqual(ZERO_MICROS);
  });
});

describe('estimateBatchMotionCost — per-shot reference-only', () => {
  // A batch can mix: a shot overrides the sequence's start-frame mode either
  // way. Pricing every shot on one shot's answer (the old `.some()`) quoted
  // the reference-to-video rate for shots that animate from a still.
  const shots = [
    { id: 'shot-a', useStartFrame: false },
    { id: 'shot-b', useStartFrame: true },
  ];
  const seedanceBoth = {
    selected: new Map([
      ['shot-a', 'seedance_v2_5'],
      ['shot-b', 'seedance_v2_5'],
    ]),
    lastFailed: new Map<string, string>(),
  };
  const price = (referenceOnly: boolean | ((s: { id: string }) => boolean)) =>
    Number(
      estimateBatchMotionCost(shots, seedanceBoth, sequence, {
        pricing: seedanceUnequalPricing,
        hasReferenceImages: false,
        referenceOnly,
      })
    );

  it('prices a mixed batch between the all-on and all-off totals', () => {
    const mixed = price((shot) => shot.id === 'shot-a');
    expect(mixed).toBeGreaterThan(price(false));
    expect(mixed).toBeLessThan(price(true));
  });

  it('still accepts a plain boolean for a uniform batch', () => {
    expect(price(() => true)).toBe(price(true));
  });
});
