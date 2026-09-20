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
import {
  loadShotDialogueResolver,
  requireSelectableSection,
} from '@/shots/server/shot-dialogue';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const logger = getLogger(['openstory', 'serverFn', 'shot-dialogue']);

const shotInput = z.object({ sequenceId: ulidSchema, shotId: ulidSchema });

/**
 * The key a reading must carry to speak this shot's lines as they stand.
 * What the shot says now, by the one resolver every reader uses. Empty when
 * nothing is voiced — no reading matches that.
 */
async function currentSourceKey(
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
): Promise<string> {
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
  return dialogueClipSourceKey(
    voicedDialogueLines(dialogueOf({ id: shotId }), characters)
  );
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
      maxSeconds: dialogueAudioMaxSeconds(videoModels),
    });
    const [candidate, currentKey] = await Promise.all([
      scopedDb.shotDialogue.getSectionById(data.sectionId),
      currentSourceKey(scopedDb, shot.id, sequence.id),
    ]);
    const section = requireSelectableSection({
      section: candidate,
      shotId: shot.id,
      currentKey,
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

/** Every authored version of this shot's lines, newest first. */
export const listShotDialogueVersionsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(
    async ({ context }) =>
      await context.scopedDb.shotDialogue.listVersions(context.shot.id)
  );

/**
 * Point the shot back at an earlier set of lines. The pointer is the whole
 * change (#1657): every reader resolves what a shot says from the selected
 * version. The shot's current reading stops matching, so the next render
 * records; a reading of the restored wording can be picked again with Use.
 */
export const selectShotDialogueVersionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ versionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const version = await context.scopedDb.shotDialogue.selectVersion(
      context.shot.id,
      data.versionId
    );
    try {
      await context.scopedDb.sequenceEvents.record({
        sequenceId: context.sequence.id,
        actorId: context.user.id,
        kind: 'dialogue.version.selected',
        targetType: 'shot',
        targetId: context.shot.id,
        data: { versionId: version.id },
      });
    } catch (error) {
      logger.error('dialogue.version.selected event not recorded', {
        shotId: context.shot.id,
        versionId: version.id,
        err: error,
      });
    }
    return { versionId: version.id };
  });

/** Discard a reading. Discarding the current one leaves the shot with no clip. */
export const discardShotDialogueSectionFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ sectionId: ulidSchema })))
  .handler(async ({ context, data }) => {
    await context.scopedDb.shotDialogue.discardSection(
      context.shot.id,
      data.sectionId
    );
    try {
      await context.scopedDb.sequenceEvents.record({
        sequenceId: context.sequence.id,
        actorId: context.user.id,
        kind: 'dialogue.section.discarded',
        targetType: 'shot',
        targetId: context.shot.id,
        data: { sectionId: data.sectionId },
      });
    } catch (error) {
      logger.error('dialogue.section.discarded event not recorded', {
        shotId: context.shot.id,
        sectionId: data.sectionId,
        err: error,
      });
    }
    return { sectionId: data.sectionId };
  });

/** This shot's dialogue recordings in flight (#1657) — the "Recording…" rows. */
export const listShotDialogueClaimsFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(async ({ context }) => {
    const claims = await context.scopedDb.shotDialogue.listLiveClaims(
      context.shot.id
    );
    return claims.map((claim) => ({
      id: claim.id,
      createdAt: claim.createdAt,
      // Demoted: it still records, but it will not become the shot's audio.
      willBecomeCurrent: claim.pendingSourceKey !== null,
    }));
  });

/**
 * Stop a recording in flight from becoming this shot's audio. The run is not
 * terminated — it records the scene for other shots too — and its reading for
 * this shot lands in the list, unselected.
 */
export const cancelShotDialogueClaimFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput.extend({ claimId: ulidSchema })))
  .handler(async ({ context, data }) => ({
    cancelled: await context.scopedDb.shotDialogue.cancelClaim(
      context.shot.id,
      data.claimId
    ),
  }));
