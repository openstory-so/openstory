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

const nameTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);

/**
 * Bible ids of the characters with a dialogue line in the analysed scenes.
 * Speaker cues are the LLM's spelling of the name ("SARAH"), the bible's is
 * the full one ("Detective Sarah Chen"), so they match on a shared name
 * token rather than exact text. Empty cues (narrator) match nobody.
 */
export function speakingCharacterIds(
  bible: readonly Pick<CharacterBibleEntry, 'characterId' | 'name'>[],
  scenes: readonly Pick<Scene, 'originalScript'>[]
): string[] {
  const spoken = new Set(
    scenes.flatMap((scene) =>
      scene.originalScript.dialogue.flatMap((line) =>
        nameTokens(line.character)
      )
    )
  );
  return bible
    .filter((character) =>
      nameTokens(character.name).some((token) => spoken.has(token))
    )
    .map((character) => character.characterId);
}
