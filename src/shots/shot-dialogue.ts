/**
 * The shot dialogue node, client-safe (#1657).
 *
 * Lines belong to the SHOT. A scene's conversation is its shots in order,
 * then each shot's lines in order — built here, never stored. One ElevenLabs
 * Text to Dialogue call records a conversation so every turn is acted in
 * context, and each shot it spoke keeps a time range of that speech.
 *
 * A turn's `index` is its position among THAT SHOT's lines, which is what
 * `VoicedDialogueLine.index` has always meant: the prompt mirror
 * (`withVoicedLineTokens`), the clip's `spokenLines` and the shorten-dialogue
 * rewrite all index into the shot's own `MotionDialogue.lines`. A turn's
 * place in the conversation is its array position — never stored, so the two
 * cannot disagree.
 *
 * Keeping `index` shot-relative is what lets every #1554/#1651 helper —
 * `voicedDialogueLines`, `dialogueClipSourceKey`, `matchingDialogueClips`,
 * `withSpokenText`, `spokenLinesFor` — work unchanged on one shot's section
 * of a speech. Nothing downstream learns that the speech was wider.
 */

import {
  DIALOGUE_TTS_MODEL,
  DIALOGUE_TTS_STABILITY,
  ttsCharacterCount,
  voicedDialogueLines,
  type VoiceCharacter,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ShotDialogueLine } from '@/platform/server/db/schema/shot-dialogue-versions';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';

export type { ShotDialogueLine };

/**
 * Characters of `ttsUtterance` text per Text to Dialogue call. ElevenLabs'
 * own reliability line for v3 — past it a long conversation starts dropping
 * turns. A conversation over the line is split at a SHOT boundary, never
 * inside a shot, so no section is ever cut across two speeches.
 */
export const DIALOGUE_TAKE_CHUNK_CHARS = 2000;

/** When one of a shot's lines is heard, in seconds from the start of the shot's clip. */
export type DialogueLineTiming = {
  /** Index into the shot's dialogue lines. */
  index: number;
  startSeconds: number;
  endSeconds: number;
};

/**
 * A shot's line timing, read off its selected section (#1853): the speech's
 * turns for this shot, moved to the section's origin — which is where the
 * cut file, and so the theatre's clip, starts. Never stored: the speech
 * already holds it.
 */
export function sectionLineTiming(section: {
  shotId: string;
  fromSeconds: number;
  speechTurns: readonly {
    shotId: string;
    index: number;
    startSeconds: number;
    endSeconds: number;
  }[];
}): DialogueLineTiming[] {
  return section.speechTurns
    .filter((turn) => turn.shotId === section.shotId)
    .map((turn) => ({
      index: turn.index,
      startSeconds: Math.max(0, turn.startSeconds - section.fromSeconds),
      endSeconds: Math.max(0, turn.endSeconds - section.fromSeconds),
    }));
}

/** The speech a clip was cut from, under its pre-#1913 key too. */
export function clipSpeechId(clip: MotionAudioClip): string | undefined {
  return clip.speechId ?? clip.recordingId;
}

/**
 * A voice change re-records everyone it was recorded with (#1802): a speech
 * is out of date once any voice that spoke in it is no longer a cast voice —
 * a scene-mate was acting against the old one. A line edit stays narrow: it
 * moves only the edited shot's key.
 */
export function speechVoicesMoved(
  turns: readonly { voiceId: string }[],
  castVoiceIds: ReadonlySet<string>
): boolean {
  return turns.some((turn) => !castVoiceIds.has(turn.voiceId));
}

/**
 * The shots whose audio a voice change has dated (#1802). A voice change
 * re-records the whole scene, so a shot is out of date when its speech
 * - was spoken by a voice the cast no longer uses (`speechVoicesMoved`), or
 * - predates the current voice of anyone who speaks in its scene — a speech
 *   can leave a scene-mate out (a Seed and an ElevenLabs voice never share a
 *   call), and that shot must not keep a take from before the change.
 *
 * Who speaks in a scene is read off its shots' speeches: every turn names
 * its voice, and every voice belongs to one character.
 */
export function voiceMovedShotIds(input: {
  shots: readonly { id: string; sceneId: string | null; speechIds: string[] }[];
  speeches: ReadonlyMap<
    string,
    { turns: readonly { voiceId: string }[]; createdAt: Date }
  >;
  castVoiceIds: ReadonlySet<string>;
  /** Voice id → the character it belongs to (any version, old ones too). */
  characterOfVoice: ReadonlyMap<string, string>;
  /** Character id → when the voice it speaks in now was made. */
  currentVoiceSince: ReadonlyMap<string, Date>;
}): Set<string> {
  const latestBySceneOrShot = new Map<string, number>();
  for (const shot of input.shots) {
    const group = shot.sceneId ?? shot.id;
    for (const speechId of shot.speechIds) {
      for (const turn of input.speeches.get(speechId)?.turns ?? []) {
        const character = input.characterOfVoice.get(turn.voiceId);
        const since = character && input.currentVoiceSince.get(character);
        if (since && since.getTime() > (latestBySceneOrShot.get(group) ?? 0)) {
          latestBySceneOrShot.set(group, since.getTime());
        }
      }
    }
  }
  return new Set(
    input.shots.flatMap((shot) => {
      const latest = latestBySceneOrShot.get(shot.sceneId ?? shot.id) ?? 0;
      const moved = shot.speechIds.some((speechId) => {
        const speech = input.speeches.get(speechId);
        return (
          speech !== undefined &&
          (speechVoicesMoved(speech.turns, input.castVoiceIds) ||
            speech.createdAt.getTime() < latest)
        );
      });
      return moved ? [shot.id] : [];
    })
  );
}

/** The voices the cast speaks in now. */
export const castVoiceIds = (
  characters: readonly { voiceId: string | null }[]
): Set<string> =>
  new Set(characters.flatMap((c) => (c.voiceId ? [c.voiceId] : [])));

/** A voiced turn of a conversation; `index` is shot-relative. */
export type SceneVoicedLine = VoicedDialogueLine & {
  shotId: string;
};

/** A shot's lines as the prompt and the per-shot hashes see them. */
export function shotDialogue(
  lines: readonly ShotDialogueLine[]
): MotionDialogue {
  return { presence: lines.length > 0, lines: [...lines] };
}

/**
 * The clip's record of the lines its render prompt quoted
 * (`VideoManifestEntry.dialogueKey`, #1784): every line, voiced or not, with
 * its bound voice token, in order. `audioSourceKey` covers voiced lines only
 * and is null on a model without dialogue-audio input, yet an audio-capable
 * model splices every line into its prompt. Null when there are none.
 */
export function dialogueLinesKey(
  dialogue: MotionDialogue | null | undefined
): string | null {
  if (!dialogue?.presence || dialogue.lines.length === 0) return null;
  return dialogue.lines
    .map((line) =>
      [line.character, line.line, line.tone, line.voiceToken ?? ''].join('\t')
    )
    .join('\n');
}

/**
 * A shot's lines derived from the selected script version, for a shot with no
 * `shot_dialogue_versions` row yet — every shot from before #1657. No
 * backfill migration: the derivation IS the old meaning of the data.
 *
 * A line's `shotNumber` (stamped by the shot-list call, #1585) names the shot
 * with that number. A line with no stamp predates #1585, when every clip of
 * the scene carried the whole conversation; it goes to the FIRST shot only,
 * so it is spoken once rather than once per clip. A stamp naming a shot that
 * no longer exists matches nobody, so it is spoken by nobody.
 */
export function deriveShotDialogueLines(
  scriptDialogue: readonly DialogueLine[] | undefined,
  shot: { shotNumber?: number | null },
  isFirstShot: boolean
): ShotDialogueLine[] {
  return (scriptDialogue ?? [])
    .filter((line) =>
      line.shotNumber == null
        ? isFirstShot
        : line.shotNumber === shot.shotNumber
    )
    .map((line) => ({
      character: line.character,
      line: line.line,
      tone: line.tone,
      ...(line.voiceToken ? { voiceToken: line.voiceToken } : {}),
    }));
}

/**
 * What a shot says NOW — the one answer every reader uses (#1657), so the
 * speech, the prompt text and the panel cannot disagree:
 *
 * 1. its selected `shot_dialogue_versions` row;
 * 2. else the dialogue its motion prompt row carried — only rows from before
 *    the node existed have one, nothing writes it any more;
 * 3. else the lines the script stamps onto it (`deriveShotDialogueLines`).
 *
 * An empty selected row is an answer ("this shot lost its lines"), so it
 * stops the ladder; an empty legacy copy is not, because it never meant that.
 */
export function resolveShotDialogue(input: {
  selectedLines: readonly ShotDialogueLine[] | null | undefined;
  legacyDialogue: MotionDialogue | null | undefined;
  scriptDialogue: readonly DialogueLine[] | undefined;
  shot: { shotNumber?: number | null };
  isFirstShot: boolean;
}): MotionDialogue {
  if (input.selectedLines) return shotDialogue(input.selectedLines);
  if (input.legacyDialogue && input.legacyDialogue.lines.length > 0) {
    return input.legacyDialogue;
  }
  return shotDialogue(
    deriveShotDialogueLines(input.scriptDialogue, input.shot, input.isFirstShot)
  );
}

/**
 * The first live shot of each scene, by shot number — the shot a pre-#1585
 * unstamped line is derived onto (`deriveShotDialogueLines`).
 */
export function firstShotIdByScene(
  shots: readonly {
    id: string;
    sceneId: string | null;
    shotNumber: number | null;
    deletedAt?: Date | null;
  }[]
): ReadonlyMap<string, string> {
  const first = new Map<string, string>();
  const ordered = [...shots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  for (const shot of ordered) {
    if (!shot.sceneId || shot.deletedAt || first.has(shot.sceneId)) continue;
    first.set(shot.sceneId, shot.id);
  }
  return first;
}

/**
 * Every voiced turn of the scene, in speaking order: shot order, then line
 * order within the shot. Built per shot so the voicing rule
 * (`voicedDialogueLines`) and the shot-relative `index` come from exactly one
 * place.
 */
export function sceneConversation(
  shotsInOrder: readonly { id: string }[],
  linesByShotId: ReadonlyMap<string, readonly ShotDialogueLine[]>,
  characters: readonly VoiceCharacter[]
): SceneVoicedLine[] {
  const out: SceneVoicedLine[] = [];
  for (const shot of shotsInOrder) {
    const lines = linesByShotId.get(shot.id) ?? [];
    for (const voiced of voicedDialogueLines(shotDialogue(lines), characters)) {
      out.push({ ...voiced, shotId: shot.id });
    }
  }
  return out;
}

/** The shot ids these voiced turns belong to, in speaking order. */
export function voicedShotIds(lines: readonly SceneVoicedLine[]): string[] {
  return [...new Set(lines.map((line) => line.shotId))];
}

/**
 * The speech key (`dialogue_speeches.inputHash`): the voiced turns in
 * speaking order, each with the shot it belongs to, the voice speaking it,
 * the words, the tone, and the TTS model + stability the whole call is
 * recorded with. Null when nothing is voiced — there is nothing to key.
 *
 * Order, not sorted: a call records a conversation, so who speaks after whom
 * is part of what was recorded.
 */
export function speechKey(voiced: readonly SceneVoicedLine[]): string | null {
  if (voiced.length === 0) return null;
  const body = voiced
    .map((line) => [line.shotId, line.voiceId, line.text, line.tone].join('\t'))
    .join('\n');
  return `${DIALOGUE_TTS_MODEL}\t${DIALOGUE_TTS_STABILITY}\n${body}`;
}

/**
 * What to record for one shot: its own turns plus whole neighbouring shots,
 * grown outward alternately (previous, next, …) while the `ttsUtterance`
 * character total stays within `maxChars`. Order preserved. The shot's own
 * turns are always in, whatever they total; a side stops growing at the first
 * neighbour that does not fit, so the window never skips a shot. The window
 * IS the conversation that gets sent: the provider's segments name array
 * positions in it.
 */
export function contextWindow(
  voiced: readonly SceneVoicedLine[],
  shotId: string,
  maxChars = DIALOGUE_TAKE_CHUNK_CHARS
): SceneVoicedLine[] {
  const shotIds = voicedShotIds(voiced);
  const at = shotIds.indexOf(shotId);
  if (at === -1) return [];
  const turnsOf = (index: number) =>
    voiced.filter((line) => line.shotId === shotIds[index]);

  let from = at;
  let to = at;
  let size = ttsCharacterCount(turnsOf(at));
  let canGrowBack = true;
  let canGrowForward = true;
  const grow = (index: number): boolean => {
    if (index < 0 || index >= shotIds.length) return false;
    const chars = ttsCharacterCount(turnsOf(index));
    if (size + chars > maxChars) return false;
    size += chars;
    return true;
  };
  while (canGrowBack || canGrowForward) {
    if (canGrowBack) {
      canGrowBack = grow(from - 1);
      if (canGrowBack) from--;
    }
    if (canGrowForward) {
      canGrowForward = grow(to + 1);
      if (canGrowForward) to++;
    }
  }
  const kept = new Set(shotIds.slice(from, to + 1));
  return voiced.filter((line) => kept.has(line.shotId));
}
