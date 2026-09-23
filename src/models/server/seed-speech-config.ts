/**
 * BytePlus Seed Speech env — Seed Audio 1.0 character voices and dialogue
 * (#1765).
 *
 * Platform key only, like `ARK_API_KEY` / `ELEVENLABS_API_KEY`: no team row,
 * no BYOK. Workflows spend it through
 * `scopedDb.credentials.resolveKey('seed-speech')`.
 *
 * A Seed voice also needs ElevenLabs — voice isolation cleans its reference
 * clips and Scribe transcribes every take for the invented-words check — so
 * `isSeedVoiceConfigured` asks for both.
 */

import { getEnv } from '#env';
import { isElevenLabsConfigured } from './elevenlabs-config';

const DEFAULT_BASE_URL = 'https://voice.ap-southeast-1.bytepluses.com';

function optionalEnv(name: string): string | undefined {
  const value = Reflect.get(getEnv(), name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function getSeedSpeechApiKey(): string | undefined {
  return optionalEnv('SEED_SPEECH_API_KEY');
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
