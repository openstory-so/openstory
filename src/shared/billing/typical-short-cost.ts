/**
 * Live "cost of another short" for balance copy (#1299).
 *
 * Same composition as the signup-grant guard in `__tests__/constants.test.ts`
 * — Enhance 30s target with Turbo defaults, motion + music on — but priced
 * from the live catalog instead of a literal, so the low-balance toast quotes
 * what a run actually costs today. Reference-only because that is the default
 * for a new sequence (no shot stills to bill).
 */

import {
  TURBO_DEFAULT_AUDIO,
  TURBO_DEFAULT_IMAGE,
  TURBO_DEFAULT_VIDEO,
} from '@/shared/ai/generation-mode';
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { TYPICAL_SHORT_COST_USD } from '@/shared/billing/constants';
import { microsToUsd } from '@/shared/billing/money';
import { estimateStoryboardPreflightCost } from '@/shared/billing/storyboard-preflight-cost';
import { DEFAULT_ASPECT_RATIO } from '@/shared/constants/aspect-ratios';

/** Enhance's default target duration — the short we quote. */
const TYPICAL_SHORT_SECONDS = 30;

/**
 * Rough USD cost of another default short. Falls back to the static
 * `TYPICAL_SHORT_COST_USD` when pricing hasn't loaded or the table is empty
 * (fresh deploy before the pricing cron has run) — an empty table prices
 * every endpoint at its gate floor, which would quote a short at ~$1.
 */
export function typicalShortCostUsd(
  pricing: Record<string, EffectiveFalPricing> | null | undefined
): number {
  if (!pricing || Object.keys(pricing).length === 0) {
    return TYPICAL_SHORT_COST_USD;
  }

  return microsToUsd(
    estimateStoryboardPreflightCost({
      script: '',
      imageModel: TURBO_DEFAULT_IMAGE,
      aspectRatio: DEFAULT_ASPECT_RATIO,
      autoGenerateMotion: true,
      videoModels: [TURBO_DEFAULT_VIDEO],
      autoGenerateMusic: true,
      audioModels: [TURBO_DEFAULT_AUDIO],
      referenceOnly: true,
      targetDurationSeconds: TYPICAL_SHORT_SECONDS,
      pricing,
    })
  );
}
