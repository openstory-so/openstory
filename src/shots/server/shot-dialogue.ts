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

import {
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  matchingDialogueClips,
  modelTakesDialogueAudio,
  ttsCharacterCount,
  voicedDialogueLines,
  type VoiceCharacter,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { ImageToVideoModel } from '@/models/models';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import { NotFoundError, ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  BatchDialogueRecording,
  DialogueAudioSceneJob,
} from '@/platform/server/workflow/types';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';
import {
  contextWindow,
  firstShotIdByScene,
  resolveShotDialogue,
  sceneConversation,
  voicedShotIds,
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
 * What a shot's motion prompt is written from (#1784): the resolver's answer,
 * and whether it is a row on the shot's dialogue node. A shot with no row
 * still says what the script says, so a motion digest stamped from the
 * script before #1784 still describes it (`legacyScriptDialogue`).
 */
export type ShotPromptDialogue = { dialogue: MotionDialogue; onNode: boolean };

export function shotPromptDialogueResolver(
  input: Parameters<typeof shotDialogueResolver>[0]
): (shot: { id: string }) => ShotPromptDialogue {
  const dialogueOf = shotDialogueResolver(input);
  return (shot) => ({
    dialogue: dialogueOf(shot),
    onNode: input.linesByShotId.has(shot.id),
  });
}

/** {@link ShotPromptDialogue} for one shot, every read made here. */
export async function loadShotPromptDialogue(
  scopedDb: Pick<
    ScopedDb,
    | 'shotDialogue'
    | 'scenes'
    | 'sceneScriptVersions'
    | 'shots'
    | 'shotPromptVersions'
  >,
  sequenceId: string,
  shot: { id: string }
): Promise<ShotPromptDialogue> {
  const [linesByShotId, sceneContext, shots, selectedMotion] =
    await Promise.all([
      loadShotDialogueLines(scopedDb, sequenceId),
      loadSceneContextBySequence(scopedDb, sequenceId),
      scopedDb.shots.listBySequence(sequenceId),
      scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
    ]);
  return shotPromptDialogueResolver({
    linesByShotId,
    shots,
    legacyDialogueOf: (shotId) =>
      shotId === shot.id ? selectedMotion?.dialogue : undefined,
    scriptDialogueOf: (sceneId) => sceneContext.get(sceneId)?.script?.dialogue,
  })(shot);
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
 * One recording job per scene that holds a shot needing audio (#1657) — what a
 * batch trigger snapshots so the batch records each scene ONCE before it fans
 * out, instead of every clip-less child recording its own window of it.
 *
 * A job is the scene's WHOLE conversation: every live shot, in shot order,
 * saying what `dialogueOf` resolves. The recorder decides who adopts
 * (`planSceneAdoption`: any shot whose clip no longer matches), so a
 * scene-mate outside the batch whose lines or voice moved gets its audio too.
 */
export function sceneDialogueJobs(input: {
  /** Shots about to render that speak and hold no matching clip. */
  needing: readonly { id: string }[];
  /** Every shot of the sequence. */
  shots: readonly {
    id: string;
    sceneId: string | null;
    shotNumber: number | null;
    deletedAt?: Date | null;
  }[];
  dialogueOf: ShotDialogueResolver;
  characters: readonly VoiceCharacter[];
  /** shot id → its selected `shot_dialogue_versions` row, when it has one. */
  versionIdByShotId: ReadonlyMap<string, string>;
  /** The clip length a reading has to fit, per shot. */
  shotSecondsOf: (shotId: string) => number | undefined;
}): DialogueAudioSceneJob[] {
  const byId = new Map(input.shots.map((shot) => [shot.id, shot]));
  const sceneIds = new Set(
    input.needing.flatMap((shot) => {
      const sceneId = byId.get(shot.id)?.sceneId;
      return sceneId ? [sceneId] : [];
    })
  );
  return [...sceneIds].flatMap((sceneId) => {
    const sceneShots = input.shots
      .filter((shot) => shot.sceneId === sceneId && !shot.deletedAt)
      .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0));
    const voiced = sceneConversation(
      sceneShots,
      new Map(
        sceneShots.map((shot) => [shot.id, input.dialogueOf(shot).lines])
      ),
      input.characters
    );
    if (voiced.length === 0) return [];
    const speaking = voicedShotIds(voiced);
    return [
      {
        voiced,
        dialogueVersionIdByShotId: Object.fromEntries(
          speaking.flatMap((shotId) => {
            const versionId = input.versionIdByShotId.get(shotId);
            return versionId ? [[shotId, versionId]] : [];
          })
        ),
        shotSeconds: Object.fromEntries(
          speaking.flatMap((shotId) => {
            const seconds = input.shotSecondsOf(shotId);
            return seconds === undefined ? [] : [[shotId, seconds]];
          })
        ),
        forceAdoptShotIds: [],
      },
    ];
  });
}

/**
 * Everything a batch-style trigger has to say about dialogue, in one call
 * (#1657) — so no trigger can send the prompt and forget the audio:
 *
 * - per shot: its `voicedLines`, the clips that still match them, and the
 *   `dialogueContext` its run falls back to if it has to record alone;
 * - `dialogueRecording`: one job per scene that needs audio, which the batch
 *   records ONCE before it fans out;
 * - `ttsChars`: what to reserve — a scene is one call over its whole
 *   conversation; only a shot with no scene is priced on its own lines.
 */
export function snapshotBatchDialogue<
  S extends {
    id: string;
    sceneId: string | null;
    durationMs?: number | null;
    audioClips?: MotionAudioClip[] | null;
  },
>(input: {
  /** The shots about to render. */
  rendering: readonly S[];
  modelOf: (shot: S) => ImageToVideoModel;
  /** Every shot of the sequence. */
  shots: Parameters<typeof shotDialogueResolver>[0]['shots'];
  dialogueOf: ShotDialogueResolver;
  characters: readonly VoiceCharacter[];
  versionIdByShotId: ReadonlyMap<string, string>;
}): {
  byShotId: ReadonlyMap<
    string,
    {
      voicedLines: VoicedDialogueLine[];
      audioClips: MotionAudioClip[];
      dialogueContext: SceneVoicedLine[] | undefined;
    }
  >;
  dialogueRecording: BatchDialogueRecording | undefined;
  ttsChars: number;
} {
  const byShotId = new Map(
    input.rendering.map((shot) => {
      const voicedLines = modelTakesDialogueAudio(input.modelOf(shot))
        ? voicedDialogueLines(input.dialogueOf(shot), input.characters)
        : [];
      const audioClips = matchingDialogueClips(shot.audioClips, voicedLines);
      return [
        shot.id,
        {
          voicedLines,
          audioClips,
          dialogueContext: dialogueContextFor({
            shot,
            voicedLines,
            audioClips,
            sceneShots: input.shots.filter(
              (other) =>
                shot.sceneId !== null &&
                other.sceneId === shot.sceneId &&
                !other.deletedAt
            ),
            dialogueOf: input.dialogueOf,
            characters: input.characters,
          }),
        },
      ] as const;
    })
  );
  const needing = input.rendering.filter((shot) => {
    const entry = byShotId.get(shot.id);
    return (
      entry && entry.voicedLines.length > 0 && entry.audioClips.length === 0
    );
  });
  const renderingById = new Map(input.rendering.map((shot) => [shot.id, shot]));
  const scenes = sceneDialogueJobs({
    needing,
    shots: input.shots,
    dialogueOf: input.dialogueOf,
    characters: input.characters,
    versionIdByShotId: input.versionIdByShotId,
    // A scene-mate outside the batch has no model resolved for it; its
    // reading then only has to fit the provider's limit.
    shotSecondsOf: (shotId) => {
      const shot = renderingById.get(shotId);
      return shot
        ? resolveShotDuration({
            durationMs: shot.durationMs,
            model: input.modelOf(shot),
          })
        : undefined;
    },
  });
  const models = [...new Set(needing.map((shot) => input.modelOf(shot)))];
  return {
    byShotId,
    dialogueRecording:
      scenes.length > 0
        ? {
            scenes,
            minDurationSeconds: dialogueAudioMinSeconds(models),
            maxDurationSeconds: dialogueAudioMaxSeconds(models),
          }
        : undefined,
    ttsChars:
      scenes.reduce((sum, job) => sum + ttsCharacterCount(job.voiced), 0) +
      needing
        .filter((shot) => !shot.sceneId)
        .reduce(
          (sum, shot) =>
            sum + ttsCharacterCount(byShotId.get(shot.id)?.voicedLines ?? []),
          0
        ),
  };
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
