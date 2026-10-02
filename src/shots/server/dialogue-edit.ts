/**
 * Shot dialogue edits shared by the editor's server fns and the MCP tools:
 * pick a version of the lines, pick or discard a reading (section).
 */
import {
  DIALOGUE_TTS_MODEL,
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  dialogueClipSourceKey,
  dialogueFitBudget,
  sectionClip,
  voicedDialogueLines,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { safeImageToVideoModel } from '@/models/models';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { castVoiceIds, speechVoicesMoved } from '@/shots/shot-dialogue';
import type { ShotEditContext } from './shot-context';
import {
  loadShotDialogueResolver,
  loadVoiceMovedShotIds,
  requireSelectableSection,
} from './shot-dialogue';

const logger = getLogger(['openstory', 'shots', 'dialogue-edit']);

type DialogueEditContext = Pick<
  ShotEditContext,
  'scopedDb' | 'shot' | 'sequence' | 'user'
>;

export async function currentSourceKeys(
  scopedDb: Pick<
    ScopedDb,
    | 'shots'
    | 'shotDialogue'
    | 'shotPromptVersions'
    | 'characters'
    | 'scenes'
    | 'sceneScriptVersions'
  >,
  shotId: string,
  sequenceId: string
): Promise<{
  key: string;
  untokenedKey: string;
  voiced: VoicedDialogueLine[];
  /** The voices the cast speaks in now (`speechVoicesMoved`). */
  castVoices: Set<string>;
}> {
  const [shots, selectedMotion, characters] = await Promise.all([
    scopedDb.shots.listBySequence(sequenceId),
    scopedDb.shotPromptVersions.getSelectedMotion(shotId),
    scopedDb.characters.list(sequenceId),
  ]);
  const dialogueOf = await loadShotDialogueResolver(
    scopedDb,
    sequenceId,
    shots,
    () => selectedMotion?.dialogue
  );
  const dialogue = dialogueOf({ id: shotId });
  const voiced = voicedDialogueLines(dialogue, characters);
  return {
    voiced,
    castVoices: castVoiceIds(characters),
    key: dialogueClipSourceKey(voiced),
    // The key the lines would have with every line on Generated: a shot moved
    // to Video model or an audio element voices nothing, so `key` is empty,
    // yet its words may be exactly what a reading spoke (#1773).
    untokenedKey: dialogueClipSourceKey(
      voicedDialogueLines(
        {
          ...dialogue,
          lines: dialogue.lines.map(({ voiceToken: _, ...line }) => line),
        },
        characters
      )
    ),
  };
}

/**
 * A source key without its voices. Each key line is
 * `voiceId \t line \t tone \t model` (`dialogueClipSourceKey`); with the first
 * column gone, two keys are equal exactly when only a voice moved. Covers the
 * readings with no version id to compare: lines still derived from the script.
 */
const wordsOfKey = (key: string): string =>
  key
    .split('\n')
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .join('\n');

/** This shot's readings, newest first; discarded ones omitted. */

/** This shot's readings, newest first; discarded ones omitted. */
export async function listShotDialogueReadings(
  context: Pick<ShotEditContext, 'scopedDb' | 'shot' | 'sequence'>
) {
  const [sections, keys, currentVersion, shots] = await Promise.all([
    context.scopedDb.shotDialogue.listSections(context.shot.id),
    currentSourceKeys(context.scopedDb, context.shot.id, context.sequence.id),
    context.scopedDb.shotDialogue.getSelected(context.shot.id),
    context.scopedDb.shots.listBySequence(context.sequence.id),
  ]);
  // The current reading answers to the scene-wide rule; an older one only
  // to the voices that spoke in it.
  const currentVoiceMoved = (
    await loadVoiceMovedShotIds(context.scopedDb, context.sequence.id, shots)
  ).has(context.shot.id);
  const { key: currentKey, untokenedKey, castVoices } = keys;
  return sections.map((section) => {
    const ownKeyMatches = currentKey !== '' && section.sourceKey === currentKey;
    // A voice that spoke in its speech is gone — a scene-mate's counts too:
    // this shot was acted against it (#1802).
    const voicesMoved =
      section.selectedAt != null
        ? currentVoiceMoved
        : speechVoicesMoved(section.speechTurns, castVoices);
    return {
      id: section.id,
      source: section.source,
      selected: section.selectedAt != null,
      fromSeconds: section.fromSeconds,
      toSeconds: section.toSeconds,
      speechUrl: section.speechUrl,
      // Every turn of a call runs on one model; the first says which.
      model: section.speechTurns[0]?.ttsModel ?? DIALOGUE_TTS_MODEL,
      createdAt: section.createdAt,
      matchesCurrentLines: ownKeyMatches,
      // Lines the take check could not find in this reading (#1802).
      unclearLineCount: section.speechTurns.filter(
        (turn) =>
          turn.shotId === context.shot.id && turn.heardShare !== undefined
      ).length,
      // WHY it no longer matches, when it does not. The key folds words and
      // voices together; the version the reading spoke tells them apart: same
      // version, moved key → the voice changed (a recast). Unknown (a reading
      // from before the id was stamped) reads as the lines. Words are compared
      // as if every line were Generated, so a source pick that kept the words
      // (Video model, an element) reads as the voice, not the lines (#1773).
      mismatch: ownKeyMatches
        ? voicesMoved
          ? ('voice' as const)
          : null
        : (section.dialogueVersionId !== null &&
              section.dialogueVersionId === currentVersion?.id) ||
            wordsOfKey(section.sourceKey) === wordsOfKey(untokenedKey)
          ? ('voice' as const)
          : ('lines' as const),
    };
  });
}

/** The event is logged, not thrown: the write it describes already landed. */
async function recordDialogueEvent(
  context: DialogueEditContext,
  kind: string,
  data: Record<string, string>
): Promise<void> {
  try {
    await context.scopedDb.sequenceEvents.record({
      sequenceId: context.sequence.id,
      actorId: context.user.id,
      kind,
      targetType: 'shot',
      targetId: context.shot.id,
      data,
    });
  } catch (error) {
    logger.error(`${kind} event not recorded`, {
      shotId: context.shot.id,
      ...data,
      err: error,
    });
  }
}

/**
 * Make a reading the shot's current one and put its cut file on the shot —
 * pointer and clip in one batch (`selectSection`). The cut comes first: it is
 * a deterministic cache write, so a failure there changes nothing.
 */
export async function selectShotDialogueSection(
  context: DialogueEditContext,
  sectionId: string
) {
  const { scopedDb, shot, sequence } = context;
  const videoModels = [safeImageToVideoModel(sequence.videoModel)];
  const { limitSeconds } = dialogueFitBudget({
    maxSeconds: dialogueAudioMaxSeconds(videoModels),
  });
  const [candidate, { key: currentKey }] = await Promise.all([
    scopedDb.shotDialogue.getSectionById(sectionId),
    currentSourceKeys(scopedDb, shot.id, sequence.id),
  ]);
  const section = requireSelectableSection({
    section: candidate,
    shotId: shot.id,
    currentKey,
    limitSeconds,
  });

  const cut = await cutAudioSection({
    storageKey: section.speech.storageKey,
    speechId: section.speechId,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
    fromSeconds: section.fromSeconds,
    toSeconds: section.toSeconds,
    minDurationSeconds: dialogueAudioMinSeconds(videoModels),
  });

  const clip = sectionClip(
    { ...section, speechTurns: section.speech.turns },
    cut
  );
  await scopedDb.shotDialogue.selectSection(shot.id, section.id, [clip]);
  await recordDialogueEvent(context, 'dialogue.section.selected', {
    sectionId: section.id,
  });
  return { sectionId: section.id, clip };
}

/**
 * Point the shot back at an earlier set of lines. The pointer is the whole
 * change (#1657): every reader resolves what a shot says from the selected
 * version. The shot's current reading stops matching, so the next render
 * records; a reading of the restored wording can be picked again.
 */
export async function selectShotDialogueVersion(
  context: DialogueEditContext,
  versionId: string
) {
  const version = await context.scopedDb.shotDialogue.selectVersion(
    context.shot.id,
    versionId
  );
  await recordDialogueEvent(context, 'dialogue.version.selected', {
    versionId: version.id,
  });
  return { versionId: version.id };
}

/** Discard a reading. Discarding the current one leaves the shot with no clip. */
export async function discardShotDialogueSection(
  context: DialogueEditContext,
  sectionId: string
) {
  await context.scopedDb.shotDialogue.discardSection(
    context.shot.id,
    sectionId
  );
  await recordDialogueEvent(context, 'dialogue.section.discarded', {
    sectionId,
  });
  return { sectionId };
}
