/**
 * Regenerate Frames Workflow
 *
 * Bulk regenerates frame images after character/location recast. Operates
 * entirely from an inlined snapshot DTO assembled at trigger time — no live
 * mutable reads inside `context.run`.
 *
 * Convergent path (current inputs match snapshot): records `thumbnailInputHash`
 * on the frame and the matching `frame_variants` row alongside the primary
 * write that `image-workflow` already performed.
 * Divergent path (something changed mid-flight): leaves the primary frame
 * artifact alone and rewrites the per-model `frame_variants` row as a
 * divergence (input_hash + diverged_at) so the UI can offer it as an
 * alternative without disturbing the user's live thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RegenerateFramesWorkflowInput } from '@/lib/workflow/types';
import { getFalFlowControl } from './constants';
import { generateImageWorkflow } from './image-workflow';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';

type FrameResult = {
  frameId: string;
  success: boolean;
  imageUrl?: string;
  error?: string;
};

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedFrames: string[];
  divergedFrameIds: string[];
};

export const regenerateFramesWorkflow = createScopedWorkflow<
  RegenerateFramesWorkflowInput,
  RegenerateFramesResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, teamId, triggeringCharacterId } = input;
    const label = buildWorkflowLabel(sequenceId);

    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    const snapshots = input.frameSnapshots;
    if (snapshots.length === 0) {
      return {
        totalFrames: 0,
        successCount: 0,
        failedFrames: [],
        divergedFrameIds: [],
      };
    }

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const aspectRatio = input.aspectRatio;

    await context.run('emit-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.recast:start', {
        characterId: triggeringCharacterId,
        frameCount: snapshots.length,
      });
    });

    const imageResults: FrameResult[] = await Promise.all(
      snapshots.map(async (snapshot) => {
        if (!snapshot.imagePrompt) {
          throw new WorkflowValidationError(
            `Frame ${snapshot.frameId} has no image prompt`
          );
        }

        const referenceImages = [
          ...snapshot.characterRefs,
          ...snapshot.locationRefs,
        ];

        const { body, isFailed, isCanceled } = await context.invoke('image', {
          workflow: generateImageWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId,
            sequenceId,
            frameId: snapshot.frameId,
            prompt: snapshot.imagePrompt,
            model: imageModel,
            imageSize: aspectRatioToImageSize(aspectRatio),
            numImages: 1,
            referenceImages,
          },
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
          flowControl: getFalFlowControl(),
        });

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (isFailed || isCanceled || !body?.imageUrl) {
          return {
            frameId: snapshot.frameId,
            success: false,
            error: 'Image generation failed',
          };
        }

        return {
          frameId: snapshot.frameId,
          success: true,
          imageUrl: body.imageUrl,
        };
      })
    );

    const divergedFrameIds: string[] = [];

    await context.run('reconcile-divergence', async () => {
      const allCharacters =
        await scopedDb.characters.listWithSheets(sequenceId);
      const allLocations =
        await scopedDb.sequenceLocations.listWithReferences(sequenceId);

      for (const result of imageResults) {
        if (!result.success || !result.imageUrl) continue;

        const snapshot = snapshots.find((s) => s.frameId === result.frameId);
        if (!snapshot) continue;

        const liveFrame = await scopedDb.frames.getById(result.frameId);
        if (!liveFrame) continue;

        const currentSnapshot = await buildRegenerateFrameSnapshot({
          frame: liveFrame,
          characters: allCharacters,
          locations: allLocations,
          imageModel,
          aspectRatio,
        });

        if (currentSnapshot.snapshotInputHash === snapshot.snapshotInputHash) {
          // Convergent: image-workflow already wrote the primary; record the
          // input-hash on both the frame and the variant row so downstream
          // staleness reads compare against this snapshot.
          await scopedDb.frames.update(
            result.frameId,
            { thumbnailInputHash: snapshot.snapshotInputHash },
            { throwOnMissing: false }
          );
          await scopedDb.frameVariants.updateByFrameAndModel(
            result.frameId,
            'image',
            imageModel,
            { inputHash: snapshot.snapshotInputHash, divergedAt: null }
          );
          continue;
        }

        // Divergent: route the result to frame_variants tagged with
        // snapshotInputHash + divergedAt and revert the speculative primary
        // write so the user's live edits keep ownership of the thumbnail.
        const divergedAt = new Date();
        divergedFrameIds.push(result.frameId);

        await scopedDb.frameVariants.updateByFrameAndModel(
          result.frameId,
          'image',
          imageModel,
          {
            inputHash: snapshot.snapshotInputHash,
            divergedAt,
          }
        );

        await scopedDb.frames.update(
          result.frameId,
          {
            thumbnailUrl: null,
            thumbnailPath: null,
            thumbnailStatus: 'pending',
            thumbnailWorkflowRunId: null,
            thumbnailGeneratedAt: null,
            thumbnailError: null,
            thumbnailInputHash: null,
          },
          { throwOnMissing: false }
        );

        await getGenerationChannel(sequenceId).emit(
          'generation.image:progress',
          {
            frameId: result.frameId,
            status: 'pending',
            model: imageModel,
          }
        );

        console.log(
          '[RegenerateFramesWorkflow]',
          `Diverged frame ${result.frameId}: snapshot=${snapshot.snapshotInputHash.slice(0, 8)} current=${currentSnapshot.snapshotInputHash.slice(0, 8)}`
        );
      }
    });

    const failedFrames = imageResults
      .filter((r) => !r.success)
      .map((r) => r.frameId);
    const successCount = imageResults.length - failedFrames.length;

    await context.run('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.recast:complete',
        {
          characterId: triggeringCharacterId,
          successCount,
          failedCount: failedFrames.length,
        }
      );
    });

    console.log(
      '[RegenerateFramesWorkflow]',
      `Completed: ${successCount} success, ${failedFrames.length} failed, ${divergedFrameIds.length} diverged`
    );

    return {
      totalFrames: snapshots.length,
      successCount,
      failedFrames,
      divergedFrameIds,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      if (input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.recast:failed',
          {
            characterId: input.triggeringCharacterId,
            error,
          }
        );
      }

      console.error(
        '[RegenerateFramesWorkflow]',
        `Frame regeneration failed: ${error}`
      );

      return `Frame regeneration failed: ${error}`;
    },
    snapshot: {
      computeFromDto: (input) => computeRegenerateFramesBatchHash(input),
      computeCurrent: async (input, scopedDb) => {
        if (!input.sequenceId) {
          throw new WorkflowValidationError(
            'Sequence ID is required for snapshot computation'
          );
        }
        const characters = await scopedDb.characters.listWithSheets(
          input.sequenceId
        );
        const locations = await scopedDb.sequenceLocations.listWithReferences(
          input.sequenceId
        );
        const frames = await scopedDb.frames.getByIds(input.frameIds);
        const aspectRatio = input.aspectRatio;
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const fresh = await Promise.all(
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
        return computeRegenerateFramesBatchHash({
          ...input,
          frameSnapshots: fresh,
        });
      },
    },
  }
);
