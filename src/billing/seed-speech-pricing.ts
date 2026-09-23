/**
 * Seed Speech rate card (#1765). Hand-maintained and merged into the
 * effective pricing map like the ElevenLabs and BytePlus Ark cards; native
 * spend is unaudited by the fal reconcile.
 *
 * RATE IS ADVERTISED, NOT BILL-VERIFIED. Read off
 * https://docs.byteplus.com/en/docs/byteplusvoice/audiopricing on
 * **2026-09-23**: Seed Audio 1.0 pay-as-you-go is $0.15 per minute
 * ($0.0025 per second), billed on the model's `original_duration`, which
 * includes trailing silence. Confirm against a BytePlus bill and re-date.
 */

import { micros, multiplyMicros, type Microdollars } from './money';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';

/** Billing id for Seed Audio 1.0 on Seed Speech. */
export const SEED_AUDIO_ENDPOINT = 'seed-audio';

const SEED_AUDIO_PER_SECOND = micros(2_500);

export const SEED_SPEECH_RATE_CARD: Record<string, EffectiveFalPricing> = {
  [SEED_AUDIO_ENDPOINT]: {
    unitPrice: SEED_AUDIO_PER_SECOND,
    unit: 'seconds',
    typicalUnitsPerCall: 30,
  },
};

export function isSeedSpeechPricedModel(modelId: string): boolean {
  return modelId in SEED_SPEECH_RATE_CARD;
}

/** What `billedSeconds` of Seed Audio costs. */
export function seedAudioCost(billedSeconds: number): Microdollars {
  if (!Number.isFinite(billedSeconds) || billedSeconds <= 0) return micros(0);
  return multiplyMicros(SEED_AUDIO_PER_SECOND, billedSeconds);
}
