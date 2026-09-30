/**
 * The `generateMusicWorkflow` durable workflow.
 */

import { computeSequenceMusicInputHash } from '@/shots/input-hash';
import { DEFAULT_MUSIC_MODEL } from '@/models/models';
import { uploadAudioToStorage } from '@/audio/server/audio-storage';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { buildR2Key, STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { generateMusic } from '@/audio/server/music-generation';
import { ZERO_MICROS } from '@/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/billing/server/workflow-deduction';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getGenerationChannel } from '@/platform/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

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
    // Only the primary model's track may take the sequence's pointer (#546).
    // In a multi-model fan-out secondary models open their own row and emit
    // model-scoped events; the pointer and the music status stay the
    // primary's.
    const isPrimary = input.isPrimary ?? true;

    // Row before result (#1130): the trigger opened this run's row with its
    // claim, or — a pipeline child, a payload from before the claim — the run
    // opens it here. Nothing is spent before it exists.
    let variantId: string | null = null;
    if (sequenceId) {
      variantId = await step.do('open-music-variant', async () => {
        const inputs = {
          model,
          prompt,
          tags,
          durationSeconds: duration,
        };
        if (input.variantId) {
          await scopedDb.sequenceVariants.stampMusicRun(input.variantId, {
            ...inputs,
            workflowRunId: event.instanceId,
          });
          return input.variantId;
        }
        return scopedDb.sequenceVariants.claimMusic({
          sequenceId,
          ...inputs,
          isPrimary,
          workflowRunId: event.instanceId,
        });
      });
      if (variantId === null) {
        throw new WorkflowValidationError(
          `Sequence ${sequenceId} not found — no track generated`
        );
      }
      if (isPrimary) {
        await step.do('emit-generating', async () => {
          await getGenerationChannel(sequenceId).emit(
            'generation.audio:progress',
            { status: 'generating', model }
          );
        });
      }
    }

    const audioResult = await step.do('generate-music', async () => {
      const result = await generateMusic({
        prompt,
        tags,
        duration,
        instrumental: true,
        model,
        teamId,
        sequenceId,
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
      // Native ElevenLabs already parked bytes in R2 (relative `/r2/` URL).
      // Fal still returns a CDN URL that this step downloads.
      let storagePath = audioResult.storagePath;
      if (!storagePath) {
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
        storagePath = storageResult.path;
        if (storageResult.url) {
          audioUrl = storageResult.url;
        }
      }
      if (!storagePath) {
        throw new Error('Audio storage path missing from generation result');
      }
      const inputHash = await computeSequenceMusicInputHash({
        prompt,
        tags,
        durationSeconds: actualDuration,
        audioModel: model,
      });

      if (!variantId) {
        throw new Error('Music variant row missing for a sequence run');
      }
      const openedId = variantId;
      const landed = await step.do('complete-music-variant', async () => {
        const row = await scopedDb.sequenceVariants.completeMusicClaim(
          openedId,
          {
            sequenceId,
            url: audioUrl,
            storagePath,
            durationSeconds: actualDuration,
            inputHash,
          }
        );
        return { diverged: row.divergedAt !== null };
      });

      await step.do('record-provenance', async () => {
        await recordProvenance(scopedDb.provenance, {
          teamId,
          userId: input.userId,
          assetKind: 'music_variant',
          assetId: openedId,
          storageKey: buildR2Key(STORAGE_BUCKETS.AUDIO, storagePath),
          provider: model === 'elevenlabs_music' ? 'elevenlabs' : 'fal',
          model,
          providerRequestId: falUsage?.requestId ?? null,
          workflowRunId: event.instanceId,
          prompt,
          sequenceId,
        });
      });

      if (landed.diverged) {
        // The claim moved while this run was in flight (a newer run, or the
        // user's pick): the track is parked, the pointer untouched. Emit a
        // terminal event so the UI doesn't hang on a spinner, plus the parked
        // row for the banner.
        await step.do('emit-music-diverged', async () => {
          const channel = getGenerationChannel(sequenceId);
          await channel.emit('generation.audio:progress', {
            status: 'completed',
            model,
            primary: isPrimary,
          });
          await channel.emit('generation.stale:detected', {
            entityType: 'sequence',
            entityId: sequenceId,
            artifact: 'music',
            snapshotInputHash: inputHash,
            divergedVariantId: openedId,
          });
        });
        logger.info(
          `[MusicWorkflow:cf] Music claim for sequence ${sequenceId} moved; parked as alternate (variant=${openedId})`
        );
      } else {
        await step.do('emit-music-completed', async () => {
          await getGenerationChannel(sequenceId).emit(
            'generation.audio:progress',
            { status: 'completed', audioUrl, model, primary: isPrimary }
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
      // Fail this run's row (the trigger's, or the one it opened) and clear
      // the claim only while it still names it (#1130 rule 5). A primary run
      // that died before any row existed records the failure as one.
      await scopedDb.sequenceVariants.failMusicClaim(
        {
          sequenceId: input.sequenceId,
          variantId: input.variantId,
          workflowRunId: event.instanceId,
          recordIfMissing: isPrimary ? { model } : undefined,
        },
        error
      );

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.audio:progress',
          { status: 'failed', model, primary: isPrimary }
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
