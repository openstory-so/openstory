import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/billing/fal-pricing-fixture';
import { buildFilmCostExamples } from './film-cost-examples';
import { micros } from '@/billing/money';

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

    // Align with composer duration chips (15 / 30 / 60 / 120 / 180 / 300) and default 30s.
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
});
