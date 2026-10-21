/**
 * Whether a shot spec is still about the script it was written from (#1923).
 *
 * Separate from prompt staleness. A spec is out of date when its script
 * slice, its lines, or the scene's cast / continuity tags moved. Lighting,
 * palette and style stay on the prompt hash: those rebuild for free.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import { sha256Hex } from '@/shots/input-hash';

export type ShotSpecCurrencyInput = {
  scriptExtract: string;
  lines: readonly { character: string; line: string; tone: string }[];
  characterTags: readonly string[];
  elementTags: readonly string[];
  environmentTag: string;
};

function sorted(tags: readonly string[]): string[] {
  return [...tags].map((tag) => tag.trim()).sort();
}

/** Digest of the inputs a spec version was written from. */
export async function hashShotSpecInput(
  input: ShotSpecCurrencyInput
): Promise<string> {
  return sha256Hex({
    artifact: 'shot:spec',
    scriptExtract: input.scriptExtract.trim(),
    lines: input.lines.map((line) => ({
      character: line.character.trim(),
      line: line.line.trim(),
      tone: line.tone.trim(),
    })),
    characterTags: sorted(input.characterTags),
    elementTags: sorted(input.elementTags),
    environmentTag: input.environmentTag.trim(),
  });
}

/** The scene slice and this shot's lines. Tags come from scene continuity. */
export function specCurrencyFromScene(
  scene: Scene,
  lines: readonly { character: string; line: string; tone: string }[]
): ShotSpecCurrencyInput {
  return {
    scriptExtract: scene.originalScript.extract,
    lines,
    characterTags: scene.continuity?.characterTags ?? [],
    elementTags: scene.continuity?.elementTags ?? [],
    environmentTag: scene.continuity?.environmentTag ?? '',
  };
}
