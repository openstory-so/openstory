/**
 * Shot dialogue readings (#1657): the time ranges of recordings that spoke a
 * shot's lines.
 *
 * Picking a reading cuts its file and puts that clip on the shot — the clip
 * is the working set, so moving the pointer alone would leave the shot
 * playing a different reading than the one marked current.
 */

import {
  DIALOGUE_CLIP_TOKEN,
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  dialogueClipSourceKey,
  dialogueFitBudget,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { safeImageToVideoModel } from '@/models/models';
import { NotFoundError, ValidationError } from '@/platform/errors';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import { shotDialogue } from '@/shots/shot-dialogue';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const shotInput = z.object({ sequenceId: ulidSchema, shotId: ulidSchema });

/**
 * The key a reading must carry to speak this shot's lines as they stand.
 * The shot node is the authored source; the motion row's `dialogue` is a
 * mirror and only answers for a shot that has no version row yet. Empty when
 * nothing is voiced — no reading matches that.
 */
async function currentSourceKey(
  scopedDb: Pick<
    ScopedDb,
    'shotDialogue' | 'shotPromptVersions' | 'characters'
  >,
  shotId: string,
  sequenceId: string
): Promise<string> {
  const [version, characters] = await Promise.all([
    scopedDb.shotDialogue.getSelected(shotId),
    scopedDb.characters.list(sequenceId),
  ]);
  const dialogue = version
    ? shotDialogue(version.lines)
    : (await scopedDb.shotPromptVersions.getSelectedMotion(shotId))?.dialogue;
  return dialogueClipSourceKey(voicedDialogueLines(dialogue, characters));
}

/** This shot's readings, newest first; discarded ones omitted. */
export const listShotDialogueSectionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(async ({ context }) => {
    const [sections, currentKey] = await Promise.all([
      context.scopedDb.shotDialogue.listSections(context.shot.id),
      currentSourceKey(context.scopedDb, context.shot.id, context.sequence.id),
    ]);
    return sections.map((section) => ({
      id: section.id,
      source: section.source,
      selected: section.selectedAt != null,
      fromSeconds: section.fromSeconds,
      toSeconds: section.toSeconds,
      recordingUrl: section.recordingUrl,
      createdAt: section.createdAt,
      matchesCurrentLines:
        currentKey !== '' && section.sourceKey === currentKey,
    }));
  });

/**
 * Make a reading the shot's current one and put its cut file on the shot.
 * Pointer first, mirror second: a failed mirror leaves the pointer and the
 * clip naming different readings, which the next select or render corrects —
 * whereas mirroring first could leave a clip nothing points at. The cut
 * comes before both: it is a deterministic cache write, so a failure there
 * changes nothing.
 */
export const selectShotDialogueSectionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ sectionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const { scopedDb, shot, sequence } = context;
    const section = await scopedDb.shotDialogue.getSectionById(data.sectionId);
    if (!section || section.shotId !== shot.id || section.discardedAt) {
      throw new NotFoundError('Reading not found');
    }

    const currentKey = await currentSourceKey(scopedDb, shot.id, sequence.id);
    if (currentKey === '' || section.sourceKey !== currentKey) {
      throw new ValidationError('These lines changed since this was recorded.');
    }

    const videoModels = [safeImageToVideoModel(sequence.videoModel)];
    const { limitSeconds } = dialogueFitBudget({
      shotSeconds:
        shot.durationMs && shot.durationMs > 0 ? shot.durationMs / 1000 : null,
      maxSeconds: dialogueAudioMaxSeconds(videoModels),
    });
    const seconds = section.toSeconds - section.fromSeconds;
    if (seconds > limitSeconds) {
      throw new ValidationError(
        `Reading is ${seconds.toFixed(1)}s — the limit is ${limitSeconds.toFixed(1)}s.`
      );
    }

    const cut = await cutAudioSection({
      storageKey: section.recording.storageKey,
      recordingId: section.recordingId,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      fromSeconds: section.fromSeconds,
      toSeconds: section.toSeconds,
      minDurationSeconds: dialogueAudioMinSeconds(videoModels),
    });

    await scopedDb.shotDialogue.selectSection(shot.id, section.id);
    const clip: MotionAudioClip = {
      id: section.id,
      url: cut.url,
      token: DIALOGUE_CLIP_TOKEN,
      durationSeconds: cut.durationSeconds,
      sourceKey: section.sourceKey,
      recordingId: section.recordingId,
      ...(section.spokenLines && { spokenLines: section.spokenLines }),
    };
    await scopedDb.shots.setAudioClips(shot.id, [clip]);
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: context.user.id,
      kind: 'dialogue.section.selected',
      targetType: 'shot',
      targetId: shot.id,
      data: { sectionId: section.id },
    });
    return { sectionId: section.id, clip };
  });
