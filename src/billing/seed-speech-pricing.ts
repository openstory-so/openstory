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

/**
 * One Seed voice take (#1765): ~35 s of Seed Audio ($0.0875), its Scribe pass
 * and ~30 s of isolation ($0.06) — about $0.15, rounded up.
 */
const SEED_VOICE_TAKE_ESTIMATE = micros(170_000);

/** What a new Seed voice of `takes` range reads is expected to cost. */
export function seedVoiceEstimate(takes: number): Microdollars {
  return multiplyMicros(SEED_VOICE_TAKE_ESTIMATE, takes);
}

/**
 * Seed Audio bills seconds, not characters, and a scene take runs well past
 * its words — the lab's 22 s of dialogue came back as 24–40 s. At 8
 * characters per billed second that is $0.3125 per 1,000 characters.
 */
const SEED_CHARS_PER_BILLED_SECOND = 8;

/** Pre-flight Seed Audio cost for `characterCount` characters of dialogue. */
export function seedDialogueEstimate(characterCount: number): Microdollars {
  return seedAudioCost(characterCount / SEED_CHARS_PER_BILLED_SECOND);
}
