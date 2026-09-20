/**
 * Read a shot's authored dialogue from the shot node (#1657).
 *
 * The lines live per SHOT on `shot_dialogue_versions`, one selected row per
 * shot. `shot_prompt_versions.dialogue` is still written as a mirror — the
 * prompt has to say what the audio says — but it is a copy, so every render
 * trigger resolves the lines HERE and only falls back to the mirror for a
 * shot that has no version row yet (nothing has written one, or the shot
 * predates the table).
 */

import type { VoiceCharacter } from '@/motion/dialogue-tts';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import {
  contextWindow,
  deriveShotDialogueLines,
  sceneConversation,
  shotDialogue,
  type SceneVoicedLine,
  type ShotDialogueLine,
} from '@/shots/shot-dialogue';

export type ShotDialogueLinesByShotId = ReadonlyMap<string, ShotDialogueLine[]>;

/** One read for a whole sequence — a trigger resolves every shot off it. */
export async function loadShotDialogueLines(
  scopedDb: Pick<ScopedDb, 'shotDialogue'>,
  sequenceId: string
): Promise<ShotDialogueLinesByShotId> {
  const versions =
    await scopedDb.shotDialogue.getSelectedBySequence(sequenceId);
  return new Map(versions.map((version) => [version.shotId, version.lines]));
}

/** Null when the shot has no version row — the caller uses its mirror. */
export function shotDialogueFor(
  linesByShotId: ShotDialogueLinesByShotId,
  shot: { id: string }
): MotionDialogue | null {
  const lines = linesByShotId.get(shot.id);
  return lines ? shotDialogue(lines) : null;
}

/**
 * The conversation to record around one shot (`dialogueContext` on its motion
 * payload): the scene's live shots in shot order, each speaking its selected
 * lines — or, with no row yet, the lines the script stamps onto it — windowed
 * around `shot`.
 *
 * `shotLines` are the lines the payload's `voicedLines` were built from, and
 * they win for `shot` itself: that may be the prompt mirror, and the section
 * that gets recorded has to key the same words the render asks for, or the
 * new clip would never match.
 */
export function dialogueContextFor(input: {
  shot: { id: string };
  shotLines: readonly ShotDialogueLine[];
  /** Every live shot of the shot's scene, in any order. */
  sceneShots: readonly { id: string; shotNumber: number | null }[];
  linesByShotId: ShotDialogueLinesByShotId;
  scriptDialogue: readonly DialogueLine[] | undefined;
  characters: readonly VoiceCharacter[];
}): SceneVoicedLine[] {
  const inOrder = [...input.sceneShots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  const lines = new Map<string, readonly ShotDialogueLine[]>(
    inOrder.map((member, index) => [
      member.id,
      input.linesByShotId.get(member.id) ??
        deriveShotDialogueLines(input.scriptDialogue, member, index === 0),
    ])
  );
  lines.set(input.shot.id, input.shotLines);
  return contextWindow(
    sceneConversation(inOrder, lines, input.characters),
    input.shot.id
  );
}
