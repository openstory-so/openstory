/**
 * Cloudflare Workflows port of `generateMusicWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/music-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`. */

import { computeSequenceMusicInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_MUSIC_MODEL } from '@/lib/ai/models';
import { uploadAudioToStorage } from '@/lib/audio/audio-storage';
import { recordProvenance } from '@/lib/compliance/provenance';
import { buildR2Key, STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { generateMusic } from '@/lib/audio/music-generation';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'music']);

export class MusicWorkflow extends OpenStoryWorkflowEntrypoint<MusicWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MusicWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<MusicWorkflowResult> {
    const input = event.payload;
    const { prompt, tags, duration } = input;

    if (!prompt || !tags || !duration) {
      throw new WorkflowValidationError(
        'Either prompt+tags+duration are required for music generation'
      );
    }

    const { sequenceId, teamId } = input;
    const model = input.model || DEFAULT_MUSIC_MODEL;
    // Only the primary model owns the live `sequences.music*` columns. In a
    // multi-model fan-out (#546) secondary models persist only their own
    // variant row and emit model-scoped events; writing the shared sequence row
    // would make `musicStatus`/`musicUrl` last-writer-wins across siblings.
    const isPrimary = input.isPrimary ?? true;

    if (sequenceId && isPrimary) {
      await step.do('set-generating-status', async () => {
        await scopedDb.sequence(sequenceId).updateMusicFields({
          musicStatus: 'generating',
          musicModel: model,
          musicError: null,
        });

        await getGenerationChannel(sequenceId).emit(
          'generation.audio:progress',
          {
            status: 'generating',
            model,
          }
        );
      });
    }

    const audioResult = await step.do('generate-music', async () => {
      const result = await generateMusic({
        prompt,
        tags,
        duration,
        instrumental: true,
        model,
        scopedDb: scopedDb.credentials,
        observability: {
          observationName: 'music',
          tags: ['music'],
          userId: input.userId,
          sessionId: sequenceId,
          metadata: { model },
        },
      });

      if (!result.success || !result.audioUrl) {
        throw new Error(result.error || 'Music generation failed');
      }

      return result;
    });

    const actualDuration =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      typeof audioResult.metadata?.duration === 'number'
        ? audioResult.metadata.duration
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          (input.duration ?? 60);

    // Deduct credits (skip if team used own fal key)
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    const musicCostMicros = audioResult.metadata?.cost ?? ZERO_MICROS;
    // Before the deduction guard — see recordFalUsageStep (#1069). Guarded
    // like the `?.` reads above: those encode a belief that `metadata` can be
    // absent at runtime despite the type, and an unguarded deref here would
    // throw a TypeError *after* fal generated and billed the track, failing
    // the workflow over a piece of telemetry.
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    const falUsage = audioResult.metadata
      ? await recordFalUsageStep(step, scopedDb, audioResult.metadata)
      : undefined;

    if (musicCostMicros > 0 && !audioResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: musicCostMicros,
          usedOwnKey: audioResult.metadata.usedOwnKey,
          description: `Music generation (${model})`,
          idempotencyKey: `${event.instanceId}:music`,
          reservationId: input.reservationId,
          metadata: {
            ...falUsage,
            model,
            sequenceId,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            duration: audioResult.metadata?.duration,
          },
          workflowName: 'MusicWorkflow:cf',
        });
      });
    }

    if (!audioResult.audioUrl) {
      throw new Error('Audio URL missing from generation result');
    }
    let audioUrl = audioResult.audioUrl;
    if (sequenceId) {
      const storageResult = await step.do('upload-to-storage', async () => {
        const result = await uploadAudioToStorage({
          audioUrl,
          teamId,
          sequenceId,
          sequenceTitle: 'sequence',
          sceneTitle: 'music',
        });

        if (!result.success || !result.path) {
          throw new Error('Failed to upload audio');
        }

        return { path: result.path, url: result.url };
      });
      if (storageResult.url) {
        audioUrl = storageResult.url;
      }
      const inputHash = await computeSequenceMusicInputHash({
        prompt,
        tags,
        durationSeconds: actualDuration,
        audioModel: model,
      });

      const writeResult = await step.do('write-music-variant', async () => {
        return scopedDb.sequenceVariants.writeMusicVariant({
          sequenceId,
          url: audioUrl,
          storagePath: storageResult.path,
          prompt,
          tags,
          durationSeconds: actualDuration,
          model,
          status: 'completed',
          generatedAt: new Date(),
          error: null,
          inputHash,
        });
      });

      await step.do('record-provenance', async () => {
        await recordProvenance(scopedDb.provenance, {
          teamId,
          userId: input.userId,
          assetKind: 'music_variant',
          assetId: writeResult.variant.id,
          storageKey: buildR2Key(STORAGE_BUCKETS.AUDIO, storageResult.path),
          provider: 'fal',
          model,
          providerRequestId: falUsage?.requestId ?? null,
          workflowRunId: event.instanceId,
          prompt,
          sequenceId,
        });
      });

      if (writeResult.divergent) {
        // Divergent run: prior primary on `sequences.music*` stays
        // authoritative. For the primary model, reset musicStatus from
        // 'generating' (set above) back to 'completed'; secondary models never
        // touched the shared row. Either way emit a terminal event so the UI
        // doesn't hang on a spinner. The alternate is preserved in
        // `sequence_music_variants` for future surfacing.
        const divergedVariantId = writeResult.variant.id;
        await step.do('update-sequence-music-divergent', async () => {
          if (isPrimary) {
            await scopedDb.sequence(sequenceId).updateMusicFields({
              musicStatus: 'completed',
              musicError: null,
            });
          }

          // No `audioUrl`: this run's track is the alternate, and the surviving
          // primary's URL is whatever the client already holds — re-reading it
          // here raced a concurrent promote/set-music. Omitting the field
          // leaves the cached `musicUrl` untouched and the client refetches.
          const channel = getGenerationChannel(sequenceId);
          await channel.emit('generation.audio:progress', {
            status: 'completed',
            model,
          });
          await channel.emit('generation.stale:detected', {
            entityType: 'sequence',
            entityId: sequenceId,
            artifact: 'music',
            snapshotInputHash: inputHash,
            divergedVariantId,
          });
        });
        logger.info(
          `[MusicWorkflow:cf] Diverged music result for sequence ${sequenceId}; preserved as alternate (variant=${divergedVariantId})`
        );
      } else {
        await step.do('update-sequence-music', async () => {
          // Primary owns the live columns; secondary models only emit a
          // model-scoped event so the per-model audio queries refresh without
          // clobbering the primary's `sequences.music*`.
          if (isPrimary) {
            await scopedDb.sequence(sequenceId).updateMusicFields({
              musicUrl: audioUrl,
              musicPath: storageResult.path,
              musicStatus: 'completed',
              musicGeneratedAt: new Date(),
              musicError: null,
            });
          }

          await getGenerationChannel(sequenceId).emit(
            'generation.audio:progress',
            {
              status: 'completed',
              audioUrl: audioUrl,
              model,
            }
          );
        });
      }

      // TODO: Tom Mar 2026 - Add a step to generate a music track for each scene
    }

    return { audioUrl: audioUrl, duration: actualDuration };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MusicWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    const model = input.model || DEFAULT_MUSIC_MODEL;
    const isPrimary = input.isPrimary ?? true;
    if (input.sequenceId) {
      // Only the primary model owns the live music status — a secondary model's
      // failure must not clobber a successful primary track (#546). Secondary
      // failures still emit a model-scoped event so per-model queries refresh.
      if (isPrimary) {
        await scopedDb.sequence(input.sequenceId).updateMusicFields({
          musicStatus: 'failed',
          musicError: error,
        });
      }

      // Flip this model's own variant row to `failed` regardless of `isPrimary`
      // (#547). An added (secondary) model's row was pre-stamped `pending`; left
      // alone it would spin `generating` forever and block re-adding the model.
      // Update-only — never inserts a row for a primary that never had one.
      await scopedDb.sequenceVariants.markMusicFailed(
        input.sequenceId,
        model,
        error
      );

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.audio:progress',
          { status: 'failed', model }
        );
      } catch (emitError) {
        logger.error(
          `[MusicWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }
    logger.error(
      `[MusicWorkflow:cf] Music generation failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
