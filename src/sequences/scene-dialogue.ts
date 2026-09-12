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
 *
 * Runs AFTER the shot list is attached so each line is also stamped with
 * the shot it is spoken in — otherwise a multi-shot scene repeats the whole
 * scene's lines on every clip. Two placements, in order:
 *   1. Enhancer `Shot N — Xs` labels in the slice, when they match the shot
 *      list one-to-one: the line belongs to the label section it sits in
 *      (exact, by gutter line).
 *   2. Otherwise the shot whose `action` quotes the line.
 * A line neither can place stays unstamped, which reads as "every shot".
 */

import { sceneIndexForLine } from '@/sequences/boundary-split';
import type { SceneSplitDialogueResult } from '@/sequences/response-schemas';
import type { DialogueLine } from '@/shots/scene-analysis.schema';

type ExtractedLine = SceneSplitDialogueResult['lines'][number];
type ShotRef = { shotNumber: number; action: string };
type SceneLike = {
  originalScript: { extract: string; dialogue: DialogueLine[] };
  shots?: ShotRef[];
};

const SHOT_LABEL = /^\s*Shot\s+(\d+)\s*[–—-]\s*\d+\s*s\b/i;

function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `Shot N` labels inside one scene slice, as (shot number, absolute gutter line). */
function shotLabels(
  script: string,
  start: number,
  end: number
): Array<{ shotNumber: number; line: number }> {
  const firstLine = script.slice(0, start).split('\n').length;
  const labels: Array<{ shotNumber: number; line: number }> = [];
  for (const [i, text] of script.slice(start, end).split('\n').entries()) {
    const match = text.match(SHOT_LABEL);
    if (match?.[1])
      labels.push({ shotNumber: Number(match[1]), line: firstLine + i });
  }
  return labels;
}

function placeByLabel(
  labels: ReadonlyArray<{ shotNumber: number; line: number }>,
  lineNumber: number
): number | undefined {
  let owner = labels[0];
  for (const label of labels) if (label.line <= lineNumber) owner = label;
  return owner?.shotNumber;
}

function placeByAction(
  shots: ReadonlyArray<ShotRef>,
  text: string
): number | undefined {
  const needle = normalize(text);
  const prefix = needle.slice(0, 24);
  return (
    shots.find((shot) => normalize(shot.action).includes(needle))?.shotNumber ??
    shots.find((shot) => normalize(shot.action).includes(prefix))?.shotNumber
  );
}

export function assignDialogueToScenes<T extends SceneLike>(
  script: string,
  offsets: number[],
  scenes: T[],
  lines: ExtractedLine[]
): { scenes: T[]; dropped: ExtractedLine[] } {
  const lineCount = script.split('\n').length;
  const byScene: DialogueLine[][] = scenes.map(() => []);
  const placers = scenes.map((scene, index) => {
    const shots = scene.shots ?? [];
    if (shots.length < 2) return () => undefined;
    const labels = shotLabels(
      script,
      offsets[index] ?? 0,
      offsets[index + 1] ?? script.length
    );
    const labelled =
      labels.length === shots.length &&
      labels.every((label) =>
        shots.some((shot) => shot.shotNumber === label.shotNumber)
      );
    return (lineNumber: number, text: string) =>
      labelled ? placeByLabel(labels, lineNumber) : placeByAction(shots, text);
  });
  const dropped: ExtractedLine[] = [];
  for (const extracted of lines) {
    const { lineNumber, character, line, tone } = extracted;
    const text = line.trim();
    if (text.length === 0) continue;
    if (lineNumber < 1 || lineNumber > lineCount) {
      dropped.push(extracted);
      continue;
    }
    const index = sceneIndexForLine(script, offsets, lineNumber);
    const shotNumber = placers[index]?.(lineNumber, text);
    byScene[index]?.push({
      character: character.trim(),
      line: text,
      tone,
      ...(shotNumber === undefined ? {} : { shotNumber }),
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

/**
 * The lines spoken in one shot: its own, plus any the split could not place.
 * Tolerates a missing list: pre-#1030 scene metadata did not always carry one.
 */
export function dialogueForShot(
  lines: ReadonlyArray<DialogueLine> | undefined,
  shotNumber: number
): DialogueLine[] {
  return (lines ?? []).filter(
    (line) => line.shotNumber === undefined || line.shotNumber === shotNumber
  );
}
