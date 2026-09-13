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
// NFKC folds full-width Latin ("ＳＡＲＡＨ") onto ASCII; the split keeps every
// script's letters, digits and combining marks (#1609).
const normalizeName = (name: string): string =>
  name.normalize('NFKC').toLowerCase().trim();

const nameTokens = (name: string): string[] =>
  normalizeName(name)
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));

/** Whole normalized names are equal — how a one-character name ("李") matches. */
const sameName = (cue: string, name: string): boolean => {
  const a = normalizeName(cue);
  return a !== '' && a === normalizeName(name);
};

const sharesToken = (cue: string, name: string): boolean => {
  const tokens = nameTokens(name);
  return nameTokens(cue).some((token) => tokens.includes(token));
};

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
  const cues = scenes.flatMap((scene) =>
    scene.originalScript.dialogue.map((line) => line.character)
  );
  if (cues.some((cue) => cue.trim() === '')) {
    return bible.map((c) => c.characterId);
  }
  return bible
    .filter((character) =>
      cues.some(
        (cue) =>
          sameName(cue, character.name) || sharesToken(cue, character.name)
      )
    )
    .map((character) => character.characterId);
}

/**
 * The character a speaker cue names, or undefined when nobody matches.
 *
 * Blank cues are narration: they match only when exactly one voice-only
 * character is in the list (the usual narrator). Matching everyone would
 * synthesise the same line in every voice. A whole-name match wins over a
 * shared token ("Sarah" over "Sarah's Mother"), whatever the cast order.
 */
export function matchSpeaker<T extends { name: string; voiceOnly?: boolean }>(
  speaker: string,
  characters: readonly T[]
): T | undefined {
  if (speaker.trim() === '') {
    const narrators = characters.filter((character) => character.voiceOnly);
    return narrators.length === 1 ? narrators[0] : undefined;
  }
  return (
    characters.find((character) => sameName(speaker, character.name)) ??
    characters.find((character) => sharesToken(speaker, character.name))
  );
}
