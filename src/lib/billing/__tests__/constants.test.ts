import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '@/lib/ai/models';
import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import {
  SIGNUP_GRANT_MICROS,
  formatPlatformFeePercent,
  platformFeeUsd,
  splitCheckoutAmounts,
  totalCheckoutCents,
  totalCheckoutUsd,
} from '../constants';
import { estimateStoryboardCost } from '../cost-estimation';
import { micros, microsToUsd, usdToMicros } from '../money';

/** Matches film-cost / Enhance default: 30s ≈ 6 × 5s shots. */
const WELCOME_SHORT_SCENE_COUNT = 6;
const WELCOME_SHORT_SHOT_DURATION_S = 5;
const WELCOME_SHORT_TARGET_S =
  WELCOME_SHORT_SCENE_COUNT * WELCOME_SHORT_SHOT_DURATION_S;

describe('billing constants', () => {
  it('applies platform fee only at purchase', () => {
    expect(platformFeeUsd(100)).toBeCloseTo(7);
    expect(totalCheckoutUsd(100)).toBeCloseTo(107);
    expect(formatPlatformFeePercent()).toBe('7%');
  });

  it('splits checkout into credit and fee line items', () => {
    expect(splitCheckoutAmounts(100)).toEqual({
      creditUsd: 100,
      feeUsd: 7,
      totalUsd: 107,
    });
  });

  it('rounds fee to cents for Stripe', () => {
    expect(splitCheckoutAmounts(10)).toEqual({
      creditUsd: 10,
      feeUsd: 0.7,
      totalUsd: 10.7,
    });
  });

  it('rounds fee from credit cents, not float USD', () => {
    // 1001¢ × 7% = 70.07 → 70¢
    expect(splitCheckoutAmounts(10.01)).toEqual({
      creditUsd: 10.01,
      feeUsd: 0.7,
      totalUsd: 10.71,
    });
  });

  it('totalCheckoutCents returns integer cents aligned with splitCheckoutAmounts', () => {
    expect(totalCheckoutCents(usdToMicros(100))).toBe(10_700);
    expect(totalCheckoutCents(usdToMicros(10))).toBe(1_070);
    // $10.50 → 1050¢ × 7% = 73.5 → 74¢ fee → 1124¢
    expect(totalCheckoutCents(micros(10_500_000))).toBe(1_124);
    expect(Number.isInteger(totalCheckoutCents(micros(10_010_000)))).toBe(true);
  });

  /**
   * #1062 / #1140: new users must finish a first short on welcome credits with
   * product defaults — Enhance 30s target, stills + motion + music on.
   * If this fails, raise SIGNUP_GRANT_USD or re-check default model pricing.
   */
  it('signup grant covers a default 30s stills+motion+music pre-flight estimate', () => {
    const defaultShortCost = estimateStoryboardCost({
      imageModel: DEFAULT_IMAGE_MODEL,
      aspectRatio: DEFAULT_ASPECT_RATIO,
      estimatedSceneCount: WELCOME_SHORT_SCENE_COUNT,
      autoGenerateMotion: true,
      videoModels: [DEFAULT_VIDEO_MODEL],
      videoDurationSeconds: WELCOME_SHORT_SHOT_DURATION_S,
      autoGenerateMusic: true,
      audioModels: [DEFAULT_MUSIC_MODEL],
      audioDurationSeconds: WELCOME_SHORT_TARGET_S,
      pricing: FAL_PRICING,
    });

    expect(
      SIGNUP_GRANT_MICROS,
      `SIGNUP_GRANT ($${microsToUsd(SIGNUP_GRANT_MICROS)}) must be ≥ default short estimate ($${microsToUsd(defaultShortCost).toFixed(2)}; ${DEFAULT_IMAGE_MODEL} + ${DEFAULT_VIDEO_MODEL} + ${DEFAULT_MUSIC_MODEL})`
    ).toBeGreaterThanOrEqual(defaultShortCost);
  });
});
