/**
 * The `sheetPortraitWorkflow` durable workflow: the portrait of a sheet
 * version that was just saved, generated or uploaded. The sheet is on screen
 * first; this lands after. See `sheet-portrait.ts`.
 */

import { castChannelId } from '@/cast/cast-channel';
import { drawSheetPortrait } from '@/cast/server/sheets/sheet-portrait';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getGenerationChannel } from '@/platform/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  SheetPortraitWorkflowInput,
  SheetPortraitWorkflowResult,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export class SheetPortraitWorkflow extends OpenStoryWorkflowEntrypoint<SheetPortraitWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SheetPortraitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<SheetPortraitWorkflowResult> {
    const input = event.payload;
    const { subject, versionId, sheetUrl } = input;
    const sequenceId = input.sequenceId ?? null;

    // Drawn and stored in one step (#1645). Null when the draw failed: the
    // sheet is already saved, and its tile keeps cropping it.
    const portraitUrl = await step.do('draw-portrait', () =>
      drawSheetPortrait({
        scopedDb,
        kind: subject.kind,
        sheetUrl,
        storageDir: input.storageDir,
        subjectId:
          subject.kind === 'character'
            ? subject.characterId
            : subject.locationId,
        chargeKey: event.instanceId,
        userId: input.userId,
        sequenceId,
      })
    );
    if (!portraitUrl) return { versionId, portraitUrl: null };

    // Onto the version row the trigger named, and only while it has none:
    // an attribute of that sheet, never a selection, so no claim.
    await step.do('save-portrait', async () => {
      if (subject.kind === 'character') {
        await scopedDb.characterSheetVariants.setPortrait(
          versionId,
          portraitUrl
        );
      } else {
        await scopedDb.locationSheetVariants.setPortrait(
          versionId,
          portraitUrl
        );
      }
    });

    // The upload's own event again: the tile re-reads and finds the portrait.
    await step.do('emit-portrait-ready', async () => {
      if (subject.kind === 'character') {
        await getGenerationChannel(
          castChannelId(sequenceId, subject.characterId)
        ).emit('generation.character-sheet:progress', {
          characterId: subject.characterId,
          lookId: subject.lookId,
          status: 'completed',
          sheetImageUrl: sheetUrl,
        });
        return;
      }
      if (sequenceId === null) return;
      await getGenerationChannel(sequenceId).emit(
        'generation.location-sheet:progress',
        {
          locationId: subject.locationId,
          status: 'completed',
          referenceImageUrl: sheetUrl,
        }
      );
    });

    return { versionId, portraitUrl };
  }
}
