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
 * The card is keyed by BytePlus model id and reuses the fal pricing shape, so
 * every downstream consumer — pre-flight estimation, the exact charge, the
 * /pricing page, ActionCost labels — works unchanged. The ids cannot collide
 * with fal endpoint ids (`fal-ai/…`, `bytedance/…`).
 *
 * RATES ARE ADVERTISED, NOT BILL-VERIFIED, and were read off the BytePlus
 * pricing pages on **2026-08-12**. fal's own pricing API mispriced Grok
 * Imagine by ~59x (#1069), and third-party resale rates for these models vary
 * two-fold. Confirm each rate against a real BytePlus invoice before leaning
 * on it, and re-date this line when bumping. (Seedance re-read **2026-08-19**
 * for the 2.5 bump.)
 */

import { micros } from '@/lib/billing/money';
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';

/**
 * Per-model Ark rates.
 *
 * Video bills in tokens: `tokens = (h x w x fps x duration) / 1024`, charged
 * per 1000 tokens — the same denomination and formula fal uses for the
 * Seedance endpoints it proxies, which is why `'1000 tokens'` here reuses the
 * existing `tokens` estimation strategy verbatim.
 *
 * Image bills per image. Seedream 5.0 Pro (`dola-seedream-5-0-pro-260628`)
 * is two-tier: $0.045 at or below 2.36 megapixels, $0.09 above. We render
 * at 2K, which straddles that boundary (2048x1152 is 2.36MP → lower tier;
 * a square 2K is 4.19MP → higher). The card carries the HIGHER tier
 * deliberately: an over-estimate makes the credit gate slightly
 * conservative, while an under-estimate lets a team spend past its
 * balance, which is the failure mode #1069 exists to prevent. Re-read
 * **2026-08-27** when bumping lite → Pro. The invoice check (see header)
 * is what settles which rate our id actually bills at.
 */
export const BYTEPLUS_RATE_CARD: Record<string, EffectiveFalPricing> = {
  // Seedance 2.5 — $10.70 per 1M tokens for 480p/720p output without video
  // input, confirmed against the official rate table + its worked example
  // (720p 16:9 5s = 108,000 tokens = $1.156). This is the EXACT rate for our
  // requests: the sequence builder pins 720p. Studio reference-to-video can
  // send clip/audio refs (a cheaper `$6.40/1M` tier with video input) — we
  // keep the no-video-input rate so the credit gate over-estimates. The
  // other tiers are cheaper-or-different ($6.40/1M with video input;
  // $11.70/1M for 1080p) — revisit this entry if either the builder's
  // resolution or the reference modes change.
  'dreamina-seedance-2-5-260628': {
    unitPrice: micros(10_700),
    unit: '1000 tokens',
  },
  // Seedream 5.0 Pro — $0.09 per image above 2.36MP. Exactly one image per
  // unit, so the per-call estimate is exact rather than a historical guess.
  'dola-seedream-5-0-pro-260628': {
    unitPrice: micros(90_000),
    unit: 'images',
    typicalUnitsPerCall: 1,
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
