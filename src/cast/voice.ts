/**
 * Character voices (#1553) — the client-safe rules.
 */

import type { CharacterBibleEntry, Scene } from '@/shots/scene-analysis.schema';

/**
 * Does this character get a designed voice? `characters.useVoice` NULL
 * inherits `sequences.generateVoices` — the same shape as `usesStartFrame`.
 */
export function usesVoice(
  character: { useVoice: boolean | null },
  sequence: { generateVoices: boolean }
): boolean {
  return character.useVoice ?? sequence.generateVoices;
}

/**
 * Tokens that name nobody: articles and honorifics shared across a cast
 * ("The Stranger" / "The Barista", "Dr. Chen" / "Dr. Patel"). A false match
 * here is a paid design call and an account-wide slot.
 */
const STOP_TOKENS = new Set([
  'the',
  'an',
  'of',
  'mr',
  'mrs',
  'ms',
  'dr',
  'miss',
  'sir',
  'st',
]);

// ponytail: a shared first name still matches ("Sarah" / "Sarah's Mother");
// per-cue disambiguation is the upgrade path if that bills in practice.
const nameTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));

/**
 * Bible ids of the characters with a dialogue line in the analysed scenes.
 * Speaker cues are the LLM's spelling of the name ("SARAH"), the bible's is
 * the full one ("Detective Sarah Chen"), so they match on a shared name
 * token rather than exact text. The lines come from the shot-list call
 * (#1585), which sees the cast list and is told to spell speakers as it
 * does, to speak narration through the voice-only entry, and to leave the
 * speaker empty ONLY for a voice nobody could attribute — so a blank cue
 * means "could be anyone", and every character is treated as speaking.
 * No dialogue at all (montage, pure narration with no narrator entry) means
 * no voices: Voices on is not a request to design voices nobody uses.
 */
export function speakingCharacterIds(
  bible: readonly Pick<CharacterBibleEntry, 'characterId' | 'name'>[],
  scenes: readonly Pick<Scene, 'originalScript'>[]
): string[] {
  const lines = scenes.flatMap((scene) => scene.originalScript.dialogue);
  const spoken = new Set(lines.flatMap((line) => nameTokens(line.character)));
  if (lines.some((line) => line.character.trim() === '')) {
    return bible.map((c) => c.characterId);
  }
  return bible
    .filter((character) =>
      nameTokens(character.name).some((token) => spoken.has(token))
    )
    .map((character) => character.characterId);
}

/**
 * The character a speaker cue names, or undefined when nobody matches.
 *
 * Blank cues are narration: they match only when exactly one voice-only
 * character is in the list (the usual narrator). Matching everyone would
 * synthesise the same line in every voice.
 */
export function matchSpeaker<T extends { name: string; voiceOnly?: boolean }>(
  speaker: string,
  characters: readonly T[]
): T | undefined {
  const cue = nameTokens(speaker);
  if (cue.length === 0) {
    const narrators = characters.filter((character) => character.voiceOnly);
    return narrators.length === 1 ? narrators[0] : undefined;
  }
  return characters.find((character) =>
    nameTokens(character.name).some((token) => cue.includes(token))
  );
}
