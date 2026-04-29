/**
 * Recast Character Workflow
 *
 * Orchestrates the full recast flow:
 * 1. Generate new character sheet with talent appearance
 * 2. Regenerate all frames containing the character
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { getGenerationChannel } from '@/lib/realtime';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RecastCharacterWorkflowInput } from '@/lib/workflow/types';
import { characterSheetWorkflow } from './character-sheet-workflow';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';
import { regenerateFramesWorkflow } from './regenerate-frames-workflow';

export const recastCharacterWorkflow =
  createScopedWorkflow<RecastCharacterWorkflowInput>(
    async (context, scopedDb) => {
      const input = context.requestPayload;
      const label = buildWorkflowLabel(input.sequenceId);

      console.log(
        '[RecastCharacterWorkflow]',
        `Starting recast for ${input.characterName} with ${input.affectedFrameIds.length} affected frames`
      );

      // Step 1: Generate character sheet showing talent in costume
      const { body: sheetResult, isFailed: sheetFailed } = await context.invoke(
        'character-sheet',
        {
          workflow: characterSheetWorkflow,
          label,
          body: {
            characterDbId: input.characterDbId,
            characterName: input.characterName,
            characterMetadata: input.characterMetadata,
            sequenceId: input.sequenceId,
            teamId: input.teamId,
            userId: input.userId,
            imageModel: input.imageModel,
            referenceImageUrl: input.referenceImageUrl,
            talentMetadata: input.talentMetadata,
            talentDescription: input.talentDescription,
            styleConfig: input.styleConfig,
          },
        }
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (sheetFailed || !sheetResult?.sheetImageUrl) {
        throw new Error(
          `Character sheet generation failed for ${input.characterName}`
        );
      }

      const sheetImageUrl = sheetResult.sheetImageUrl;
      console.log(
        '[RecastCharacterWorkflow]',
        `Character sheet generated for ${input.characterName}, regenerating ${input.affectedFrameIds.length} frames`
      );

      // Step 2: Regenerate frames if there are any affected
      let framesRegenerated = 0;
      let framesFailed = 0;

      if (input.affectedFrameIds.length > 0) {
        const sequenceId = input.sequenceId;
        if (!sequenceId) {
          throw new Error(
            '[RecastCharacterWorkflow] sequenceId is required to regenerate frames'
          );
        }
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const regenerateBody = await context.run(
          'build-regenerate-snapshot',
          async () => {
            const sequence = await scopedDb.sequences.getById(sequenceId);
            if (!sequence) {
              throw new Error(
                `[RecastCharacterWorkflow] Sequence ${sequenceId} not found`
              );
            }
            const [characters, locations, frames] = await Promise.all([
              scopedDb.characters.listWithSheets(sequenceId),
              scopedDb.sequenceLocations.listWithReferences(sequenceId),
              scopedDb.frames.getByIds(input.affectedFrameIds),
            ]);
            const aspectRatio = sequence.aspectRatio;
            const frameSnapshots = await Promise.all(
              frames.map((frame) =>
                buildRegenerateFrameSnapshot({
                  frame,
                  characters,
                  locations,
                  imageModel,
                  aspectRatio,
                })
              )
            );
            const partial = {
              sequenceId,
              imageModel,
              aspectRatio,
              frameSnapshots,
            };
            const snapshotInputHash =
              await computeRegenerateFramesBatchHash(partial);
            return {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              frameIds: input.affectedFrameIds,
              triggeringCharacterId: input.characterDbId,
              imageModel,
              aspectRatio,
              frameSnapshots,
              snapshotInputHash,
            };
          }
        );

        const { body: regenerateResult, isFailed: regenerateFailed } =
          await context.invoke('regenerate-frames', {
            workflow: regenerateFramesWorkflow,
            label,
            body: regenerateBody,
          });

        if (regenerateFailed) {
          console.error(
            '[RecastCharacterWorkflow]',
            `Frame regeneration failed for ${input.characterName}`
          );
        } else {
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          framesRegenerated = regenerateResult?.successCount ?? 0;
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          framesFailed = regenerateResult?.failedFrames?.length ?? 0;
          console.log(
            '[RecastCharacterWorkflow]',
            `Regenerated ${framesRegenerated} frames for ${input.characterName}`
          );
        }
      }

      return {
        sheetImageUrl,
        framesRegenerated,
        framesFailed,
      };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        await getGenerationChannel(input.sequenceId).emit(
          'generation.recast:failed',
          {
            characterId: input.characterDbId,
            error,
          }
        );

        console.error(
          '[RecastCharacterWorkflow]',
          `Recast failed for ${input.characterName}: ${error}`
        );

        return `Recast failed for ${input.characterName}`;
      },
    }
  );
