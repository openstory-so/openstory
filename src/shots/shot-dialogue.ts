import type { DialogueLine } from '@/shots/scene-analysis.schema';

/**
 * The lines spoken in one shot: its own, plus any with no shot stamp (a
 * one-shot scene, or rows from before #1585). `dialogueFromShots` is what
 * stamps them. Tolerates a missing list: pre-#1030 scene metadata did not
 * always carry one.
 */
export function dialogueForShot(
  lines: ReadonlyArray<DialogueLine> | undefined,
  shotNumber: number
): DialogueLine[] {
  return (lines ?? []).filter(
    (line) => line.shotNumber === undefined || line.shotNumber === shotNumber
  );
}
