/**
 * Join of the dialogue-extraction call onto the sliced scenes (#1585).
 *
 * Each extracted line names the gutter line it starts on; that resolves to
 * an owning scene the same way bible `firstMention`s do. The LLM result
 * REPLACES the regex-derived `originalScript.dialogue` (the streaming
 * preview value from `extractDialogueFromSlice`) on every scene, so a scene
 * the LLM found nothing in ends up with `[]`.
 *
 * A line whose gutter number is outside the script is DROPPED and reported,
 * never guessed onto scene 1 or the last scene: a misplaced spoken line is
 * audio in the wrong clip.
 */

import { sceneIndexForLine } from '@/sequences/boundary-split';
import type { SceneSplitDialogueResult } from '@/sequences/response-schemas';
import type { DialogueLine } from '@/shots/scene-analysis.schema';

type ExtractedLine = SceneSplitDialogueResult['lines'][number];

export function assignDialogueToScenes<
  T extends { originalScript: { extract: string; dialogue: DialogueLine[] } },
>(
  script: string,
  offsets: number[],
  scenes: T[],
  lines: ExtractedLine[]
): { scenes: T[]; dropped: ExtractedLine[] } {
  const lineCount = script.split('\n').length;
  const byScene: DialogueLine[][] = scenes.map(() => []);
  const dropped: ExtractedLine[] = [];
  for (const extracted of lines) {
    const { lineNumber, character, line, tone } = extracted;
    const text = line.trim();
    if (text.length === 0) continue;
    if (lineNumber < 1 || lineNumber > lineCount) {
      dropped.push(extracted);
      continue;
    }
    byScene[sceneIndexForLine(script, offsets, lineNumber)]?.push({
      character: character.trim(),
      line: text,
      tone,
    });
  }
  return {
    scenes: scenes.map((scene, index) => ({
      ...scene,
      originalScript: {
        ...scene.originalScript,
        dialogue: byScene[index] ?? [],
      },
    })),
    dropped,
  };
}
