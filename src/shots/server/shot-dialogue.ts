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
import { NotFoundError, ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import {
  contextWindow,
  sceneConversation,
  sceneShotLines,
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
 *
 * Undefined unless the run has to record: voiced lines and no matching clip.
 */
export function dialogueContextFor(input: {
  shot: { id: string };
  shotLines: readonly ShotDialogueLine[];
  voicedLines: readonly unknown[];
  audioClips: readonly unknown[];
  /** Every live shot of the shot's scene, in any order. */
  sceneShots: readonly { id: string; shotNumber: number | null }[];
  linesByShotId: ShotDialogueLinesByShotId;
  scriptDialogue: readonly DialogueLine[] | undefined;
  characters: readonly VoiceCharacter[];
}): SceneVoicedLine[] | undefined {
  if (input.voicedLines.length === 0 || input.audioClips.length > 0) {
    return undefined;
  }
  const inOrder = [...input.sceneShots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  const lines = sceneShotLines(
    inOrder,
    (shotId) => input.linesByShotId.get(shotId),
    input.scriptDialogue
  );
  lines.set(input.shot.id, input.shotLines);
  return contextWindow(
    sceneConversation(inOrder, lines, input.characters),
    input.shot.id
  );
}

/**
 * May this reading become the shot's current one? Refuses another shot's row
 * (the only thing between a caller and a cut of someone else's recording —
 * `getSectionById` is unscoped), a discarded one, one recorded for lines that
 * have since changed, and one longer than the shot can carry. Measures the
 * raw section; `recordDialogue` measures the padded file, so a reading at
 * the provider's floor can pass there and still be padded here.
 */
export function requireSelectableSection<
  S extends {
    shotId: string;
    discardedAt: Date | null;
    sourceKey: string;
    fromSeconds: number;
    toSeconds: number;
  },
>(input: {
  section: S | null;
  shotId: string;
  /** `''` when the shot voices nothing — no reading matches that. */
  currentKey: string;
  limitSeconds: number;
}): S {
  const { section, shotId, currentKey, limitSeconds } = input;
  if (!section || section.shotId !== shotId || section.discardedAt) {
    throw new NotFoundError('Reading not found');
  }
  if (currentKey === '' || section.sourceKey !== currentKey) {
    throw new ValidationError('These lines changed since this was recorded.');
  }
  const seconds = section.toSeconds - section.fromSeconds;
  if (seconds > limitSeconds) {
    throw new ValidationError(
      `Reading is ${seconds.toFixed(1)}s — the limit is ${limitSeconds.toFixed(1)}s.`
    );
  }
  return section;
}
