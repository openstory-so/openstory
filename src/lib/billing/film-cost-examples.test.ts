import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import { TURBO_DEFAULT_IMAGE } from '@/lib/ai/generation-mode';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { buildFilmCostExamples } from './film-cost-examples';
import { micros, microsToUsd } from './money';

describe('buildFilmCostExamples', () => {
  it('returns null when the default image model has no pricing signal', () => {
    expect(buildFilmCostExamples({})).toBeNull();
  });

  it('hides the showcase when Lite only has fal’s $1/unit catalog stub', () => {
    const stub = {
      ...FAL_PRICING,
      'google/nano-banana-2-lite': {
        unitPrice: micros(1_000_000),
        unit: 'units',
      },
    };
    expect(buildFilmCostExamples(stub)).toBeNull();
  });

  it('builds three tiers for a 30s Enhance target, not an orphan 40s runtime', () => {
    const result = buildFilmCostExamples(FAL_PRICING);
    expect(result).not.toBeNull();
    if (!result) return;

    // Align with composer duration chips (15 / 30 / 60 / 180) and default 30s.
    expect(result.targetDurationSeconds).toBe(30);
    expect(result.sceneCount * result.shotDurationSeconds).toBe(
      result.targetDurationSeconds
    );

    expect(result.examples).toHaveLength(3);
    const [images, motion, full] = result.examples;
    expect(images).toBeDefined();
    expect(motion).toBeDefined();
    expect(full).toBeDefined();
    if (!images || !motion || !full) return;

    expect(motion.costMicros).toBeGreaterThan(images.costMicros);
    expect(full.costMicros).toBeGreaterThan(motion.costMicros);
    expect(images.cost.startsWith('~')).toBe(true);
    expect(images.subtitle).toMatch(/30s target/);
    expect(images.breakdown.some((line) => /est\./i.test(line))).toBe(true);
    expect(motion.breakdown.some((line) => /refs/i.test(line))).toBe(true);
    expect(motion.breakdown.some((line) => /6 × 5s/i.test(line))).toBe(true);
  });

  it('keeps the full stills+motion+music tier within the welcome grant under fixture pricing', () => {
    const result = buildFilmCostExamples(FAL_PRICING);
    expect(result).not.toBeNull();
    if (!result) return;

    const full = result.examples.find((e) => e.id === 'with-motion-music');
    expect(full).toBeDefined();
    if (!full) return;

    expect(
      full.costMicros,
      `with-motion-music ($${microsToUsd(full.costMicros).toFixed(2)} with ${TURBO_DEFAULT_IMAGE}) should fit in welcome grant ($${microsToUsd(SIGNUP_GRANT_MICROS)})`
    ).toBeLessThanOrEqual(SIGNUP_GRANT_MICROS);
  });
});
