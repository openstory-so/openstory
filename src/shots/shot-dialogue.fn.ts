/**
 * Shot dialogue readings (#1657): the time ranges of recordings that spoke a
 * shot's lines.
 *
 * Picking a reading cuts its file and puts that clip on the shot — the clip
 * is the working set, so moving the pointer alone would leave the shot
 * playing a different reading than the one marked current.
 */

import {
  dialogueAudioMaxSeconds,
  dialogueAudioMinSeconds,
  dialogueClipSourceKey,
  dialogueFitBudget,
  sectionClip,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import { safeImageToVideoModel } from '@/models/models';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { requireSelectableSection } from '@/shots/server/shot-dialogue';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import { shotDialogue } from '@/shots/shot-dialogue';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const logger = getLogger(['openstory', 'serverFn', 'shot-dialogue']);

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
 * Make a reading the shot's current one and put its cut file on the shot —
 * pointer and clip in one batch (`selectSection`). The cut comes first: it is
 * a deterministic cache write, so a failure there changes nothing. The event
 * comes last and is logged, not thrown: both writes already landed.
 */
export const selectShotDialogueSectionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ sectionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const { scopedDb, shot, sequence } = context;
    const videoModels = [safeImageToVideoModel(sequence.videoModel)];
    const { limitSeconds } = dialogueFitBudget({
      shotSeconds:
        shot.durationMs && shot.durationMs > 0 ? shot.durationMs / 1000 : null,
      maxSeconds: dialogueAudioMaxSeconds(videoModels),
    });
    const section = requireSelectableSection({
      section: await scopedDb.shotDialogue.getSectionById(data.sectionId),
      shotId: shot.id,
      currentKey: await currentSourceKey(scopedDb, shot.id, sequence.id),
      limitSeconds,
    });

    const cut = await cutAudioSection({
      storageKey: section.recording.storageKey,
      recordingId: section.recordingId,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      fromSeconds: section.fromSeconds,
      toSeconds: section.toSeconds,
      minDurationSeconds: dialogueAudioMinSeconds(videoModels),
    });

    const clip = sectionClip(section, cut);
    await scopedDb.shotDialogue.selectSection(shot.id, section.id, [clip]);
    try {
      await scopedDb.sequenceEvents.record({
        sequenceId: sequence.id,
        actorId: context.user.id,
        kind: 'dialogue.section.selected',
        targetType: 'shot',
        targetId: shot.id,
        data: { sectionId: section.id },
      });
    } catch (error) {
      logger.error('dialogue.section.selected event not recorded', {
        shotId: shot.id,
        sectionId: section.id,
        err: error,
      });
    }
    return { sectionId: section.id, clip };
  });
