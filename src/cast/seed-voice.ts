/**
 * Seed voices (#1765) — the client-safe rules.
 *
 * A Seed voice is not an account slot. It is three reference clips cut from
 * one range read (normal / quiet / loud), stored in R2 under the voice's id,
 * and every line is recorded with the clip that matches its mood. The id
 * rides in the same `voiceId` column as an ElevenLabs id, so matching,
 * hashing and staleness do not change; the `seed:` prefix is what says which
 * provider records it. A voice keeps its provider for life — there is no
 * hop between the two.
 */

import { generateId } from '@/platform/id';

const SEED_VOICE_PREFIX = 'seed:';

/** The model every Seed voice is made and recorded with. */
export const SEED_AUDIO_MODEL = 'seed-audio-1.0';

/**
 * Range reads per new Seed voice. Each take is a different person reading the
 * same description (a description alone never locks a Seed voice), paid for
 * separately — so the user picks how many to audition (#1765).
 */
export const SEED_VOICE_MAX_TAKES = 3;
export const SEED_VOICE_DEFAULT_TAKES = 2;

export const SEED_VOICE_MOODS = ['normal', 'quiet', 'loud'] as const;
export type SeedVoiceMood = (typeof SEED_VOICE_MOODS)[number];

/** What a Seed voice holds in R2 (`voice.json`). Written once, never changed. */
export type SeedVoiceBundle = {
  description: string;
  /** `<bucket>/<path>` of each isolated reference clip. */
  clips: Record<SeedVoiceMood, string>;
};

export function isSeedVoiceId(voiceId: string | null | undefined): boolean {
  return typeof voiceId === 'string' && voiceId.startsWith(SEED_VOICE_PREFIX);
}

/** Which provider made (and records) a voice — shown on the voice card. */
export function voiceProviderLabel(voiceId: string): string {
  return isSeedVoiceId(voiceId) ? 'Seed Audio' : 'ElevenLabs';
}

export function newSeedVoiceId(): string {
  return `${SEED_VOICE_PREFIX}${generateId()}`;
}

/** AUDIO-bucket folder holding one Seed voice's bundle and clips. */
export function seedVoiceFolder(voiceId: string): string {
  return `seed-voices/${voiceId.slice(SEED_VOICE_PREFIX.length)}`;
}

/**
 * Which reference clip a line is recorded against. Seed copies the
 * reference's delivery as well as its voice, so a whisper needs the quiet
 * clip and a shout the loud one. Everything else — sad, tender and tired
 * included — takes the normal clip with the mood said in words: mapping sad
 * to the quiet clip made sad lines whisper.
 */
export function moodForTone(tone: string): SeedVoiceMood {
  const t = tone.toLowerCase();
  if (/whisper|hush|secret|murmur|under (?:her|his|their) breath/.test(t)) {
    return 'quiet';
  }
  if (/annoy|angr|shout|yell|scream|furious|excit|frustrat|rais/.test(t)) {
    return 'loud';
  }
  return 'normal';
}
