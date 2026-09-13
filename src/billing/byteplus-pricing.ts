/**
 * BytePlus Ark rate card (#1157).
 *
 * Unlike fal — which publishes a pricing API the nightly cron mirrors into
 * `model_pricing` — BytePlus exposes no machine-readable rates, so this is a
 * hand-maintained card merged into the effective pricing map at read time.
 * Merging in code rather than seeding rows keeps a fresh deploy correct
 * immediately: there is no window where Ark generations bill $0 because a
 * seed step has not run (#1069's failure mode).
 *
 * Each entry carries two things (#1605): the **unit price** billing
 * multiplies (`unitsBilled × unitPrice`, Ark reports tokens ÷ 1000 or an
 * image count), and the page's full tariff as a **rate card** in
 * `rate-card/cards/` — per-resolution rates, the with-video tier, the
 * pixel tiers — which the estimator evaluates against the request. The
 * cards are keyed by BytePlus model id and reuse the fal pricing shape, so
 * every downstream consumer — pre-flight estimation, the exact charge, the
 * /pricing page, ActionCost labels — works unchanged. The ids cannot
 * collide with fal endpoint ids (`fal-ai/…`, `bytedance/…`).
 *
 * RATES ARE ADVERTISED, NOT BILL-VERIFIED, read off the BytePlus pricing
 * page on **2026-09-13** (each card quotes its text). fal's own pricing API
 * mispriced Grok Imagine by ~59x (#1069), and third-party resale rates for
 * these models vary two-fold. Confirm each rate against a real BytePlus
 * invoice before leaning on it, and re-date this line when bumping.
 */

import { micros } from './money';
import { BYTEPLUS_CARDS } from './rate-card/cards';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';

const card = (id: string): EffectiveFalPricing['rateCard'] => {
  const stored = BYTEPLUS_CARDS[id];
  if (!stored) throw new Error(`no BytePlus rate card for ${id}`);
  return { card: stored, verified: true };
};

/**
 * Per-model Ark unit prices, for billing.
 *
 * Video bills in tokens: `tokens = (h x w x fps x duration) / 1024`, charged
 * per 1000 tokens — the same denomination fal uses for the Seedance
 * endpoints it proxies. The unit price is the no-video-input rate for the
 * 720p the sequence builder pins; the card prices every other shape.
 *
 * Image bills per image. Seedream 5.0 Pro is two-tier ($0.045 at or below
 * 2.61 megapixels, $0.09 above); the unit price carries the HIGHER tier
 * deliberately, so a charge never lands under the bill (#1069) while the
 * card quotes the tier the request actually falls in.
 */
export const BYTEPLUS_RATE_CARD: Record<string, EffectiveFalPricing> = {
  'dreamina-seedance-2-5-260628': {
    unitPrice: micros(10_700),
    unit: '1000 tokens',
    rateCard: card('dreamina-seedance-2-5-260628'),
  },
  'dreamina-seedance-2-0-260128': {
    unitPrice: micros(7_000),
    unit: '1000 tokens',
    rateCard: card('dreamina-seedance-2-0-260128'),
  },
  'dreamina-seedance-2-0-mini-260615': {
    unitPrice: micros(3_500),
    unit: '1000 tokens',
    rateCard: card('dreamina-seedance-2-0-mini-260615'),
  },
  'dola-seedream-5-0-pro-260628': {
    unitPrice: micros(90_000),
    unit: 'images',
    rateCard: card('dola-seedream-5-0-pro-260628'),
  },
};

/** True when this id is priced by the card rather than by `model_pricing`. */
export function isBytePlusPricedModel(modelId: string): boolean {
  return modelId in BYTEPLUS_RATE_CARD;
}

/**
 * Ark reports video usage as a token count; billing multiplies a `1000 tokens`
 * unit price, so convert here rather than at the call site — the denomination
 * and the divisor have to move together.
 */
export function bytePlusVideoUnitsBilled(
  totalTokens: number | undefined
): number | undefined {
  if (totalTokens == null || !Number.isFinite(totalTokens)) return undefined;
  return totalTokens / 1000;
}
