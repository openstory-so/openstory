/**
 * What a shot says, read from the shot node (#1657).
 *
 * The lines live per SHOT on `shot_dialogue_versions`, one selected row per
 * shot, and that is the only place they are written. Every reader — render
 * triggers, the staleness read, the prompt preview, the UI's shot view —
 * resolves through `shotDialogueResolver`, so the recording, the prompt text
 * and the panel cannot disagree. `shot_prompt_versions.dialogue` is no longer
 * written; it is read only as the resolver's second rung, for rows from
 * before the node existed.
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
  firstShotIdByScene,
  resolveShotDialogue,
  sceneConversation,
  type SceneVoicedLine,
  type ShotDialogueLine,
} from '@/shots/shot-dialogue';
import { loadSceneContextBySequence } from './scene-script';

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

/** What a shot says now (`resolveShotDialogue`), for any shot of one sequence. */
export type ShotDialogueResolver = (shot: { id: string }) => MotionDialogue;

/**
 * Build the resolver once per request, from reads the caller already made.
 * `shots` is every shot of the sequence: the first-shot rule needs the
 * scene-mates of a shot, not just the shots being rendered.
 */
export function shotDialogueResolver(input: {
  linesByShotId: ShotDialogueLinesByShotId;
  shots: readonly {
    id: string;
    sceneId: string | null;
    shotNumber: number | null;
    deletedAt?: Date | null;
  }[];
  /** The selected motion prompt row's `dialogue` — pre-#1657 rows only. */
  legacyDialogueOf: (shotId: string) => MotionDialogue | null | undefined;
  scriptDialogueOf: (sceneId: string) => readonly DialogueLine[] | undefined;
}): ShotDialogueResolver {
  const byId = new Map(input.shots.map((shot) => [shot.id, shot]));
  const firstShotId = firstShotIdByScene(input.shots);
  return ({ id }) => {
    const shot = byId.get(id);
    const sceneId = shot?.sceneId ?? null;
    return resolveShotDialogue({
      selectedLines: input.linesByShotId.get(id),
      legacyDialogue: input.legacyDialogueOf(id),
      scriptDialogue: sceneId ? input.scriptDialogueOf(sceneId) : undefined,
      shot: { shotNumber: shot?.shotNumber },
      isFirstShot: sceneId !== null && firstShotId.get(sceneId) === id,
    });
  };
}

/**
 * {@link shotDialogueResolver} for a caller that holds neither the lines nor
 * the scene scripts yet — both read here, in parallel. `shots` is every shot
 * of the sequence, or of the scene when only one scene is being resolved.
 */
export async function loadShotDialogueResolver(
  scopedDb: Pick<ScopedDb, 'shotDialogue' | 'scenes' | 'sceneScriptVersions'>,
  sequenceId: string,
  shots: Parameters<typeof shotDialogueResolver>[0]['shots'],
  legacyDialogueOf: (shotId: string) => MotionDialogue | null | undefined
): Promise<ShotDialogueResolver> {
  const [linesByShotId, sceneContext] = await Promise.all([
    loadShotDialogueLines(scopedDb, sequenceId),
    loadSceneContextBySequence(scopedDb, sequenceId),
  ]);
  return shotDialogueResolver({
    linesByShotId,
    shots,
    legacyDialogueOf,
    scriptDialogueOf: (sceneId) => sceneContext.get(sceneId)?.script?.dialogue,
  });
}

/**
 * The conversation to record around one shot (`dialogueContext` on its motion
 * payload): the scene's live shots in shot order, each saying what
 * `dialogueOf` resolves for it, windowed around `shot`. The same resolver
 * built the payload's `voicedLines`, so the section that gets recorded keys
 * the words the render asks for.
 *
 * Undefined unless the run has to record: voiced lines and no matching clip.
 */
export function dialogueContextFor(input: {
  shot: { id: string };
  voicedLines: readonly unknown[];
  audioClips: readonly unknown[];
  /** Every live shot of the shot's scene, in any order. */
  sceneShots: readonly { id: string; shotNumber: number | null }[];
  dialogueOf: ShotDialogueResolver;
  characters: readonly VoiceCharacter[];
}): SceneVoicedLine[] | undefined {
  if (input.voicedLines.length === 0 || input.audioClips.length > 0) {
    return undefined;
  }
  const inOrder = [...input.sceneShots].sort(
    (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
  return contextWindow(
    sceneConversation(
      inOrder,
      new Map(
        inOrder.map((member) => [member.id, input.dialogueOf(member).lines])
      ),
      input.characters
    ),
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
