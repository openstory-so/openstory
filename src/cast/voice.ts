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
 * token rather than exact text. Every character is treated as speaking when
 * the cues cannot narrow it: no cue names anyone (the slice parser found no
 * speech it recognises — prose it does not parse still produces this), or a
 * blank cue is present (`extractDialogueFromSlice` leaves "A voice from
 * below says, …" unattributed: that line could be anyone). Voices was
 * switched on, and no voice at all is the worse miss.
 */
// ponytail: a montage / pure-narration script therefore designs a voice for
// everyone (one $0.30 call each); a "no speech at all" signal from the
// parser is the upgrade path if that over-spend shows up.
export function speakingCharacterIds(
  bible: readonly Pick<CharacterBibleEntry, 'characterId' | 'name'>[],
  scenes: readonly Pick<Scene, 'originalScript'>[]
): string[] {
  const lines = scenes.flatMap((scene) => scene.originalScript.dialogue);
  const spoken = new Set(lines.flatMap((line) => nameTokens(line.character)));
  const unattributed = lines.some((line) => line.character.trim() === '');
  if (spoken.size === 0 || unattributed) {
    return bible.map((c) => c.characterId);
  }
  return bible
    .filter((character) =>
      nameTokens(character.name).some((token) => spoken.has(token))
    )
    .map((character) => character.characterId);
}
