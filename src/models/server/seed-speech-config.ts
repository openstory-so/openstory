/**
 * BytePlus Seed Audio 1.5 early access (#1765). Voice generation and
 * dialogue both call `POST /api/v3/contents/generations` on ModelArk.
 *
 * The early-access key is `SEED_AUDIO_15_API_KEY`. `SEED_SPEECH_API_KEY` is
 * the live 1.0 key and is not sent. Platform only, no organization BYOK.
 * Workflows spend it through `scopedDb.credentials.resolveKey('seed-speech')`.
 *
 * A Seed voice also needs ElevenLabs — voice isolation cleans its reference
 * clips and Scribe transcribes every take to find its lines — so
 * `isSeedVoiceConfigured` asks for both.
 */

import type { VoiceProvider } from '@/cast/seed-voice';
import { getEnv } from '#env';
import { optionalEnv } from '@/platform/server/env/environment';
import { isElevenLabsConfigured } from './elevenlabs-config';

const DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com';

/** Early-access endpoint id from the integration guide. Not the model name. */
const EARLY_ACCESS_ENDPOINT = 'ep-20260921143824-2m8c9';

export function getSeedSpeechApiKey(): string | undefined {
  return optionalEnv('SEED_AUDIO_15_API_KEY');
}

/** Request `model`. The endpoint id, overridable when the official one ships. */
export function getSeedAudioEndpoint(): string {
  return optionalEnv('SEED_AUDIO_15_ENDPOINT') ?? EARLY_ACCESS_ENDPOINT;
}

export function getSeedSpeechBaseUrl(): string {
  return optionalEnv('SEED_SPEECH_BASE_URL') ?? DEFAULT_BASE_URL;
}

/**
 * True when the platform can call Seed Speech. Under `E2E_TEST` it stays off
 * unless `SEED_SPEECH_BASE_URL` is also set, so a laptop key cannot bill a
 * replay (same rule as every native via).
 */
export function isSeedSpeechConfigured(): boolean {
  if (getSeedSpeechApiKey() === undefined) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !optionalEnv('SEED_SPEECH_BASE_URL')) {
    return false;
  }
  return true;
}

/**
 * New character voices are Seed voices when this holds; otherwise Voice
 * Design on ElevenLabs, as before. Routing a NEW voice, not a job: a voice
 * keeps the provider it was made on for its whole life.
 */
export function isSeedVoiceConfigured(): boolean {
  return isSeedSpeechConfigured() && isElevenLabsConfigured();
}

/** The provider a voice made now gets, for life. */
export function newVoiceProvider(): VoiceProvider {
  return isSeedVoiceConfigured() ? 'seed' : 'elevenlabs';
}
