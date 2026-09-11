/**
 * Join of the dialogue-extraction call onto the sliced scenes (#1585).
 *
 * Each extracted line names the gutter line it starts on; that resolves to
 * an owning scene the same way bible `firstMention`s do. The LLM result
 * REPLACES the regex-derived `originalScript.dialogue` (the streaming
 * preview value from `extractDialogueFromSlice`) on every scene, so a scene
 * the LLM found nothing in ends up with `[]`.
 */

import { sceneIndexForLine } from '@/sequences/boundary-split';
import type { SceneSplitDialogueResult } from '@/sequences/response-schemas';
import type { DialogueLine } from '@/shots/scene-analysis.schema';

export function assignDialogueToScenes<
  T extends { originalScript: { extract: string; dialogue: DialogueLine[] } },
>(
  script: string,
  offsets: number[],
  scenes: T[],
  lines: SceneSplitDialogueResult['lines']
): T[] {
  const byScene: DialogueLine[][] = scenes.map(() => []);
  for (const { lineNumber, character, line, tone } of lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    const index = Math.min(
      sceneIndexForLine(script, offsets, lineNumber),
      scenes.length - 1
    );
    byScene[index]?.push({ character: character.trim(), line: text, tone });
  }
  return scenes.map((scene, index) => ({
    ...scene,
    originalScript: { ...scene.originalScript, dialogue: byScene[index] ?? [] },
  }));
}
