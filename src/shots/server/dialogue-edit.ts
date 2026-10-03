/**
 * Shot dialogue edits shared by the editor's server fns and the MCP tools:
 * pick a version of the lines, pick or discard a reading (section), record
 * the lines again, cancel a recording in flight.
 */
import {
  DIALOGUE_TTS_MODEL,
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  dialogueClipSourceKey,
  ttsCharacterCount,
  dialogueFitBudget,
  sectionClip,
  voicedDialogueLines,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { safeImageToVideoModel } from '@/models/models';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  castVoiceIds,
  speechVoicesMoved,
  voicedShotIds,
} from '@/shots/shot-dialogue';
import { estimateTtsCost } from '@/billing/elevenlabs-pricing';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { resolveShotDuration } from '@/motion/resolve-shot-duration';
import { ValidationError } from '@/platform/errors';
import type { z } from 'zod';
import type { storedMotionDialogueSchema } from '@/shots/scene-analysis.schema';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { DialogueAudioWorkflowInput } from '@/platform/server/workflow/types';
import { loadSceneContextBySequence } from './scene-script';
import type { ShotEditContext } from './shot-context';
import {
  loadShotDialogueResolver,
  loadVoiceMovedShotIds,
  requireSelectableSection,
  sceneDialogueJobs,
  shotDialogueResolver,
} from './shot-dialogue';

const logger = getLogger(['openstory', 'shots', 'dialogue-edit']);

type ShotDialogueLines = z.infer<typeof storedMotionDialogueSchema>['lines'];

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
 * Edit what this shot says (#1773): character, words, tone. Appends a
 * `user-edit` version of THIS shot's lines and nothing else — no prompt row,
 * no other shot. `write` hands back the selected row when nothing moved.
 */
export async function saveShotDialogue(
  context: Pick<ShotEditContext, 'scopedDb' | 'shot' | 'user'>,
  lines: ShotDialogueLines
): Promise<{ versionId: string | null }> {
  const version = await context.scopedDb.shotDialogue.write(
    context.shot.id,
    lines,
    'user-edit',
    { createdBy: context.user.id }
  );
  return { versionId: version?.id ?? null };
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

/**
 * Record a shot's voiced lines again (`regenerateShotDialogueFn`): the whole
 * scene's conversation is spoken in one call, and this shot adopts the new
 * reading even if its clip still matches. It lands through a claim like any
 * other speech. `scope: 'scene'` forces every voiced shot of the shot's scene
 * to adopt, so the scene is one take again.
 */
export async function regenerateShotDialogue(
  context: DialogueEditContext,
  scope: 'shot' | 'scene'
): Promise<{ workflowRunId: string }> {
  const { scopedDb, shot, sequence, user } = context;
  const [shots, characters, versions, sceneContext] = await Promise.all([
    scopedDb.shots.listBySequence(sequence.id),
    scopedDb.characters.list(sequence.id),
    // The rows, not just the lines: a speech names the version it spoke.
    scopedDb.shotDialogue.getSelectedBySequence(sequence.id),
    loadSceneContextBySequence(scopedDb, sequence.id),
  ]);
  const selectedMotionByShot =
    await scopedDb.shotPromptVersions.getSelectedMotionByShots(
      shots.map((row) => row.id)
    );
  const model = safeImageToVideoModel(sequence.videoModel);
  const [job] = sceneDialogueJobs({
    needing: [shot],
    shots,
    dialogueOf: shotDialogueResolver({
      linesByShotId: new Map(
        versions.map((version) => [version.shotId, version.lines])
      ),
      shots,
      legacyDialogueOf: (shotId) => selectedMotionByShot.get(shotId)?.dialogue,
      scriptDialogueOf: (sceneId) =>
        sceneContext.get(sceneId)?.script?.dialogue,
    }),
    characters,
    versionIdByShotId: new Map(
      versions.map((version) => [version.shotId, version.id])
    ),
    voiceMovedShotIds: await loadVoiceMovedShotIds(
      scopedDb,
      sequence.id,
      shots
    ),
    shotSecondsOf: (shotId) => {
      if (scope === 'shot' && shotId !== shot.id) return undefined;
      const row = shots.find((candidate) => candidate.id === shotId);
      return row
        ? resolveShotDuration({ durationMs: row.durationMs, model })
        : undefined;
    },
  });
  const speaking = job ? voicedShotIds(job.voiced) : [];
  const adopting =
    scope === 'scene' ? speaking : speaking.filter((id) => id === shot.id);
  if (!job || adopting.length === 0) {
    throw new ValidationError(
      scope === 'scene'
        ? 'This scene has no voiced lines to record'
        : 'This shot has no voiced lines to record'
    );
  }

  const reservationId = await reserveRunCredits(
    scopedDb,
    estimateTtsCost(ttsCharacterCount(job.voiced)),
    {
      errorMessage: 'Insufficient credits to record dialogue',
      sequenceId: sequence.id,
    }
  );
  return releaseReservationOnThrow(scopedDb, reservationId, async () => {
    const input: DialogueAudioWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      reservationId,
      ownsReservation: true,
      scenes: [
        {
          ...job,
          forceAdoptShotIds: [
            ...new Set([...job.forceAdoptShotIds, ...adopting]),
          ],
        },
      ],
      minDurationSeconds: dialogueAudioMinSeconds([model]),
      maxDurationSeconds: dialogueAudioMaxSeconds([model]),
    };
    return {
      workflowRunId: await triggerWorkflow('/dialogue-audio', input),
    };
  });
}

/** This shot's dialogue speeches in flight (#1657) — the "Generating…" rows. */
export async function listShotDialogueClaims(
  context: Pick<ShotEditContext, 'scopedDb' | 'shot'>
) {
  const claims = await context.scopedDb.shotDialogue.listLiveClaims(
    context.shot.id
  );
  return claims.map((claim) => ({
    id: claim.id,
    createdAt: claim.createdAt,
    // Demoted: it still records, but it will not become the shot's audio.
    willBecomeCurrent: claim.pendingSourceKey !== null,
  }));
}

/**
 * Stop a speech in flight from becoming this shot's audio. The run is not
 * terminated — it records the scene for other shots too — and its reading for
 * this shot lands in the list, unselected.
 */
export async function cancelShotDialogueClaim(
  context: Pick<ShotEditContext, 'scopedDb' | 'shot'>,
  claimId: string
): Promise<{ cancelled: boolean }> {
  return {
    cancelled: await context.scopedDb.shotDialogue.cancelClaim(
      context.shot.id,
      claimId
    ),
  };
}
