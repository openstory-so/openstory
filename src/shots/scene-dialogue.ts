/**
 * The scene dialogue node, client-safe (#1657).
 *
 * Dialogue is authored per SCENE and spoken per SHOT: one ElevenLabs Text to
 * Dialogue take records the whole conversation so every turn is acted in
 * context, and each shot's clip is a slice of it. So two indexes exist and
 * both matter:
 *
 *   `lineIndex` — position in the scene's ordered lines. What
 *                 `DialogueTakeSegment.lineIndex` names, and what a take
 *                 segment is matched back through.
 *   `index`     — position among THAT SHOT's lines, which is the index
 *                 `VoicedDialogueLine.index` has always meant: the prompt
 *                 mirror (`withVoicedLineTokens`), the clip's `spokenLines`
 *                 and the shorten-dialogue rewrite all index into the shot's
 *                 own `MotionDialogue.lines`.
 *
 * Keeping `index` shot-relative is what lets every #1554/#1651 helper —
 * `voicedDialogueLines`, `dialogueClipSourceKey`, `matchingDialogueClips`,
 * `withSpokenText`, `spokenLinesFor` — work unchanged on a slice of a scene
 * take. Nothing downstream learns that the recording was scene-wide.
 */

import {
  DIALOGUE_TTS_MODEL,
  DIALOGUE_TTS_STABILITY,
  voicedDialogueLines,
  type VoiceCharacter,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { SceneDialogueLine } from '@/platform/server/db/schema/scene-dialogue-versions';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';

export type { SceneDialogueLine };

/** A voiced turn of a scene take: shot-relative `index`, scene `lineIndex`. */
export type SceneVoicedLine = VoicedDialogueLine & {
  /** Index into the scene's dialogue lines. */
  lineIndex: number;
  shotId: string;
};

/**
 * The lines spoken in one shot, in scene order, as the prompt and the
 * per-shot hashes see them — `shotId` stripped, because it is a storage fact
 * (same rule `dialogueForShot` applied to `shotNumber`).
 */
export function linesForShot(
  lines: readonly SceneDialogueLine[],
  shotId: string
): MotionDialogue {
  const spoken = lines
    .filter((line) => line.shotId === shotId)
    .map(({ shotId: _shot, ...line }): DialogueLine => line);
  return { presence: spoken.length > 0, lines: spoken };
}

/** Scene positions of one shot's lines, in order — index k is that shot's k-th line. */
function sceneIndexesForShot(
  lines: readonly SceneDialogueLine[],
  shotId: string
): number[] {
  return lines.flatMap((line, index) =>
    line.shotId === shotId ? [index] : []
  );
}

/** The shot's turns that have a designed voice. Shot-relative `index`. */
export function voicedLinesForShot(
  lines: readonly SceneDialogueLine[],
  characters: readonly VoiceCharacter[],
  shotId: string
): VoicedDialogueLine[] {
  return voicedDialogueLines(linesForShot(lines, shotId), characters);
}

/**
 * Every voiced turn of the scene, in speaking order — the conversation one
 * take records. Built per shot so the voicing rule (`voicedDialogueLines`)
 * and the shot-relative `index` come from exactly one place.
 */
export function sceneVoicedLines(
  lines: readonly SceneDialogueLine[],
  characters: readonly VoiceCharacter[]
): SceneVoicedLine[] {
  const out: SceneVoicedLine[] = [];
  for (const shotId of new Set(lines.map((line) => line.shotId))) {
    const sceneIndexes = sceneIndexesForShot(lines, shotId);
    for (const voiced of voicedLinesForShot(lines, characters, shotId)) {
      const lineIndex = sceneIndexes[voiced.index];
      if (lineIndex === undefined) continue;
      out.push({ ...voiced, shotId, lineIndex });
    }
  }
  return out.sort((a, b) => a.lineIndex - b.lineIndex);
}

/** The shot ids this scene's voiced turns belong to, in speaking order. */
export function voicedShotIds(lines: readonly SceneVoicedLine[]): string[] {
  return [...new Set(lines.map((line) => line.shotId))];
}

/**
 * The take key (`scene_dialogue_takes.inputHash`): the scene's voiced turns
 * in speaking order, each with the shot it belongs to, the voice speaking it,
 * the words, the tone, and the TTS model + stability the whole take is
 * recorded with. Null when nothing is voiced — there is no take to key.
 *
 * Order, not sorted: one take records the conversation, so who speaks after
 * whom is part of what was recorded. Scene indexes are deliberately NOT in
 * here — they are implied by the order, and folding them in would move the
 * key for a shot-order change that speaks the same words in the same
 * sequence.
 */
export function dialogueTakeKey(
  lines: readonly SceneDialogueLine[],
  characters: readonly VoiceCharacter[]
): string | null {
  return takeKeyFromVoiced(sceneVoicedLines(lines, characters));
}

/**
 * The same key from turns already voiced — what a workflow holds on its
 * payload, where the characters (and their voice ids) are not re-read.
 */
export function takeKeyFromVoiced(
  voiced: readonly SceneVoicedLine[]
): string | null {
  if (voiced.length === 0) return null;
  const body = voiced
    .map((line) => [line.shotId, line.voiceId, line.text, line.tone].join('\t'))
    .join('\n');
  return `${DIALOGUE_TTS_MODEL}\t${DIALOGUE_TTS_STABILITY}\n${body}`;
}

/**
 * The scene node derived from the selected script version, for a scene with
 * no `scene_dialogue_versions` row yet — every scene from before #1657, and
 * any the References stage reaches first. No backfill migration: the
 * derivation IS the old meaning of the data.
 *
 * A line's `shotNumber` (stamped by the shot-list call, #1585) names the live
 * shot with that number. A line with no stamp predates #1585, when every clip
 * of the scene carried the whole conversation; it goes to the FIRST shot, so
 * it is spoken once rather than once per clip. A stamp naming a shot that no
 * longer exists is dropped — there is no shot to speak it, and handing it to
 * shot 1 would put a deleted shot's lines in someone else's mouth.
 */
export function deriveSceneDialogueLines(
  scriptDialogue: readonly DialogueLine[] | undefined,
  shots: ReadonlyArray<{ id: string; shotNumber?: number | null }>
): SceneDialogueLine[] {
  const byNumber = new Map(
    shots.flatMap((shot) =>
      shot.shotNumber == null ? [] : [[shot.shotNumber, shot.id] as const]
    )
  );
  const firstShotId = shots[0]?.id;
  return (scriptDialogue ?? []).flatMap((line) => {
    const shotId =
      line.shotNumber == null ? firstShotId : byNumber.get(line.shotNumber);
    if (!shotId) return [];
    return [
      {
        character: line.character,
        line: line.line,
        tone: line.tone,
        shotId,
        ...(line.voiceToken ? { voiceToken: line.voiceToken } : {}),
      } satisfies SceneDialogueLine,
    ];
  });
}

/**
 * Replace one shot's lines inside the scene's, keeping every other shot's
 * untouched and keeping order: the shot's new lines land where its old lines
 * were (at the end when it had none). A user edits one shot at a time in the
 * prompt editor; the scene node is what that edit writes to.
 */
export function replaceShotLines(
  lines: readonly SceneDialogueLine[],
  shotId: string,
  replacement: readonly Omit<SceneDialogueLine, 'shotId'>[]
): SceneDialogueLine[] {
  const stamped = replacement.map((line): SceneDialogueLine => ({
    ...line,
    shotId,
  }));
  const at = lines.findIndex((line) => line.shotId === shotId);
  const others = lines.filter((line) => line.shotId !== shotId);
  if (at === -1) return [...others, ...stamped];
  const before = lines.slice(0, at).filter((line) => line.shotId !== shotId);
  return [...before, ...stamped, ...others.slice(before.length)];
}
