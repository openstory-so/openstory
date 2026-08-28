/**
 * Image generation workflow (#989: writes to `frames` / `frame_variants`).
 *
 * The still image is the FRAME's surface now. Each run:
 *   1. set-generating-status — claim-or-append a `frame_variants` version, then
 *      (unless variantOnly) flip the primary frame to 'generating'. With
 *      `targetVariantId` (#1085) a pre-created pending claim is transitioned
 *      in place via `claimForGeneration` (no append). Without it, a new
 *      in-flight version is appended. Prep can exit null when the claim was
 *      cancelled mid-flight or the anchor frame vanished.
 *   2. generate-image / deduct-credits / upload-image — unchanged.
 *   3. persist-result — status-guarded complete (`completeIfLive`), emits
 *      `image.generated`, then SELECT-OR-NOT: a new selection is a pointer
 *      repoint (`frameVariants.select`), never an overwrite. `variantOnly`
 *      (adding a model) appends without selecting; mid-flight input drift
 *      retains a stale-flagged version without repointing the primary.
 */

import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { Frame } from '@/lib/db/schema';
import {
  CONTENT_REJECTION_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { recordProvenance } from '@/lib/compliance/provenance';
import { buildR2Key, STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { computeImageWorkflowHashFromDto } from '@/lib/workflows/image-workflow-snapshot';
import { generateImageWithContentRetry } from '@/lib/workflows/soften-image-prompt';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'image']);

type ImageWorkflowResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
  /**
   * The render's claim was cancelled by the user (before or during the
   * render) and its result was discarded (#1085). Parents must treat this as
   * a stand-down, not a success (nothing landed) and not a failure (the user
   * asked for it).
   */
  cancelled?: boolean;
};

/** Output of `set-generating-status`: the generation params plus the id of the
 * in-flight `frame_variants` version claimed or appended (empty when there's
 * no frame context, e.g. preview mode or a shotless ad-hoc generation). */
type PrepResult = {
  params: ImageGenerationParams;
  versionId: string;
};

export class ImageWorkflow extends OpenStoryWorkflowEntrypoint<ImageWorkflowInput> {
  /**
   * The frame this run writes to: the trigger's `frameId`, re-read only to
   * confirm it still exists (deleted mid-run is a stand-down). Every spawner
   * threads `frameId` alongside `shotId`; a payload without it is a stale
   * in-flight instance from a previous build — stand down rather than
   * resolve the anchor by shot, which could land on a DIFFERENT frame than
   * a sibling step resolved.
   *
   * A `shotId` with no `frameId` is logged as the invariant violation it is:
   * every caller of this reports the null as "the frame is gone", which read
   * as a routine skip for a whole release while scene-split's preview triggers
   * silently wrote nothing (#1119).
   */
  private resolveFrame(
    scopedDb: WorkflowScopedDb,
    input: Pick<ImageWorkflowInput, 'frameId' | 'shotId'>
  ): Promise<Frame | null> {
    if (!input.frameId) {
      if (input.shotId) {
        logger.warn(
          `[ImageWorkflow] Shot ${input.shotId} was triggered without a frameId; ` +
            `this run writes nothing back to the frame. Either a stale in-flight ` +
            `instance from a pre-#1067 build, or a spawner that failed to thread ` +
            `the anchor frame id.`
        );
      }
      return Promise.resolve(null);
    }
    return scopedDb.liveRead.frames.getById(input.frameId);
  }

  protected override async runImpl(
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ImageWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    if (input.sceneSnapshot) {
      await step.do('validate-snapshot', async () => {
        const expected = input.snapshotInputHash ?? '';
        const recomputed = await computeImageWorkflowHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      });
    }

    const snapshotHash: string | null =
      input.sceneSnapshot && input.snapshotInputHash
        ? input.snapshotInputHash
        : null;

    const prep = await step.do(
      'set-generating-status',
      async (): Promise<PrepResult | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        logger.info(
          `[ImageWorkflow] Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;
        // The builder orders the URLs to match the prompt's Image numbering
        // (primary → characters → locations → elements) — always send its
        // referenceUrls, not the raw input order.
        const { prompt: enhancedPrompt, referenceUrls } =
          buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          );
        const params: ImageGenerationParams = {
          model,
          prompt: enhancedPrompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
        };

        // A preview for a shot can only land if it knows its anchor frame, and
        // `record-preview-variant` doesn't find that out until after the image
        // is generated AND billed. Stand down here instead, while it is still
        // free — otherwise a payload missing `frameId` (a stale in-flight
        // instance from a pre-#1067 build, which is why the field is still
        // optional) buys an image and then discards it. That is #1119 exactly,
        // and a log line does not prevent it.
        if (input.skipStorage && input.shotId && !input.frameId) {
          logger.warn(
            `[ImageWorkflow] Shot ${input.shotId} triggered a preview without a frameId; ` +
              `standing down before spend. Either a stale pre-#1067 instance, or a ` +
              `spawner that failed to thread the anchor frame id.`
          );
          return null;
        }

        // No frame context (preview mode, or shotless ad-hoc): generate without
        // claiming a version row — no in-flight row, no status flip. A preview
        // gets its own `kind: 'preview'` row on completion, in the skipStorage
        // branch below.
        if (!input.shotId || !input.sequenceId || input.skipStorage) {
          return { params, versionId: '' };
        }

        const frame = await this.resolveFrame(scopedDb, input);
        if (!frame) {
          logger.info(
            `[ImageWorkflow] Shot ${input.shotId} has no anchor frame (deleted?), skipping`
          );
          return null;
        }

        // The trigger decided this is a real edit and snapshotted what it was
        // authored against — see UserEditProvenance.
        const editedVersion = input.userEditProvenance
          ? await scopedDb.framePromptVersions.write({
              frameId: frame.id,
              text: input.prompt,
              source: 'user-edit',
              inputHash: input.userEditProvenance.inputHash,
              analysisModel: input.userEditProvenance.analysisModel,
              createdBy: input.userId,
            })
          : null;

        // The version this run's prompt text came from (#1070): the edit we
        // just wrote, else the trigger's snapshot — including an explicit null
        // ("this prompt came from no version"). Only un-migrated triggers, which
        // omit the field entirely, fall back to a live read — that read is what
        // paired a still with a prompt it was never rendered from.
        const promptVersionId =
          editedVersion?.id ??
          (input.promptVersionId !== undefined
            ? input.promptVersionId
            : ((await scopedDb.liveRead.frames.getById(frame.id))
                ?.selectedImagePromptVersionId ?? null));
        let version;
        if (input.targetVariantId) {
          // #1085: a pre-created claim row exists — transition IT rather than
          // appending. Null = the claim was cancelled before the render
          // started; abandon the run without spending credits.
          version = await scopedDb.frameVariants.claimForGeneration(
            input.targetVariantId,
            {
              workflowRunId,
              model,
              promptVersionId,
              // Direct-regen claims already carry the hash from enqueue;
              // chained claims get it stamped here (the render's snapshot
              // hash), so "updating" detection survives the upstream prompt
              // completing.
              pendingInputHash: input.snapshotInputHash ?? null,
            }
          );
          if (!version) {
            logger.info(
              `[ImageWorkflow] claim ${input.targetVariantId} was cancelled before generation; skipping`
            );
            return null;
          }
        } else {
          version = await scopedDb.frameVariants.appendVersion({
            frameId: frame.id,
            sequenceId: input.sequenceId,
            kind: 'model',
            model,
            status: 'generating',
            workflowRunId,
            promptVersionId,
          });
        }

        // Flip the primary frame to 'generating' only AFTER the claim held
        // (#1095 review): flipping first meant a pre-render cancel abandoned
        // the run with the frame stuck 'generating' forever. Variant-only
        // (adding a model) never flips the primary — only this model's new
        // version carries the in-flight state, so the picker can't trip
        // staleness on the live selection.
        if (!input.variantOnly) {
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            // No `imageModel` — the in-flight model is recorded on the
            // version row this step just appended (#1067); the frame only
            // tracks that a primary render is running.
            {
              imageStatus: 'generating',
              imageWorkflowRunId: workflowRunId,
            },
            { throwOnMissing: false }
          );
          // Primary regen claims auto-promote; last kickoff wins (#1070).
          // variantOnly add-model never claims the primary.
          await scopedDb.frames.setPendingPromoteVersionId(
            frame.id,
            version.id
          );
        }

        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'generating',
            model,
            variantOnly: input.variantOnly,
          }
        );

        return { params, versionId: version.id };
      }
    );

    if (!prep) {
      // null prep = claim cancelled / unique-hash stand-down, OR anchor frame
      // gone mid-run. Both are stand-downs for parents today (no imageUrl,
      // cancelled: true) so Update all does not treat a missing frame as a
      // hard stage failure.
      return {
        imageUrl: '',
        shotId: input.shotId,
        sequenceId: input.sequenceId,
        cancelled: true,
      };
    }

    // Same-prompt reseeds on content-flag (#881), then Grok Imagine 2 on
    // the original prompt, then one softened prompt + retry (#1272).
    // Transient errors still throw so CF retries the named generate step.
    // A deterministic checker hit that survives all three is
    // NonRetryableError — onFailure records the real message.
    const generation = await generateImageWithContentRetry({
      step,
      scopedDb,
      workflowRunId,
      input,
      params: prep.params,
      versionId: prep.versionId,
      snapshotInputHash: snapshotHash,
    });
    const imageResult = generation.result;
    const snapshotInputHash = generation.snapshotInputHash;

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, shotId, sequenceId } = input;
    // Before the deduction guard — see recordFalUsageStep (#1069). Native
    // xAI images have no fal units; sampling them would corrupt fal medians.
    const falUsage: { requestId?: string } =
      imageResult.via === 'fal'
        ? await recordFalUsageStep(step, scopedDb, imageResult.metadata)
        : {};

    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCostMicros,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Image generation (${generation.params.model})`,
          idempotencyKey: `${event.instanceId}:image`,
          reservationId: input.reservationId,
          metadata: {
            ...falUsage,
            model: generation.params.model,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
          },
          workflowName: 'ImageWorkflow',
        });
      });
    }

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (imageUrl && shotId && sequenceId && teamId && !input.skipStorage) {
      const upload = await step.do('upload-image', async () => {
        return uploadImageToStorage({ imageUrl, teamId, sequenceId, shotId });
      });

      const writeResult = await step.do(
        'persist-result',
        async (): Promise<{ imageUrl: string; cancelled?: boolean }> => {
          const promptHash = generation.prompt
            ? simpleHash(generation.prompt)
            : null;
          const { model } = generation.params;
          const versionId = generation.versionId || prep.versionId;

          // The same frame `set-generating-status` claimed on — re-read only to
          // confirm it survived the render.
          const frame = await this.resolveFrame(scopedDb, input);
          if (!frame) {
            logger.info(
              `[ImageWorkflow] Shot ${shotId} lost its anchor frame before select; skipping`
            );
            return { imageUrl: upload.url };
          }

          // Complete the in-flight version — status-guarded, so a user cancel
          // that raced the render wins: the completed image must not resurrect
          // a cancelled claim row or repoint the selection (#1085). Its
          // inputHash IS the snapshot hash — staleness of this version is its
          // own concern (immutable once done).
          const completed = await scopedDb.frameVariants.completeIfLive(
            versionId,
            {
              url: upload.url,
              storagePath: upload.path,
              generatedAt: new Date(),
              error: null,
              promptHash,
              inputHash: snapshotInputHash,
            }
          );
          if (!completed) {
            logger.info(
              `[ImageWorkflow] version ${versionId} went terminal mid-render (user cancel); discarding result`
            );
            // Settle the primary frame the prep step flipped to 'generating' —
            // without this the shot keeps a perpetual spinner (#1095 review).
            if (!input.variantOnly) {
              const frameNow = await scopedDb.liveRead.frames.getById(frame.id);
              await scopedDb.frames.setImageGenerationStatus(
                frame.id,
                {
                  imageStatus: frameNow?.selectedImageVersionId
                    ? 'completed'
                    : 'pending',
                  imageWorkflowRunId: null,
                  imageError: null,
                },
                { throwOnMissing: false }
              );
              await scopedDb.frames.clearPendingPromoteVersionIdIf(
                frame.id,
                versionId
              );
            }
            return { imageUrl: upload.url, cancelled: true };
          }

          await scopedDb.sequenceEvents.record({
            sequenceId,
            actorId: input.userId,
            kind: 'image.generated',
            targetType: 'frame',
            targetId: frame.id,
            summary: `Generated ${model} image`,
            data: { versionId, model, variantOnly: input.variantOnly ?? false },
          });

          const channel = getGenerationChannel(sequenceId);

          // Adding a model — leave the primary selection untouched.
          if (input.variantOnly) {
            await channel.emit('generation.image:progress', {
              shotId,
              status: 'completed',
              thumbnailUrl: upload.url,
              model,
              variantOnly: true,
            });
            return { imageUrl: upload.url };
          }

          // Claim the promote in ONE conditional write: last kickoff / explicit
          // history select may have moved the pending pointer since this run
          // started (#1070), and a read-then-select loses that race.
          // Promote even if the prompt/refs drifted mid-flight — the still is
          // stamped with its own inputHash and will surface as stale if the
          // live prompt moved. Explicit selection is what cancels promote.
          const promoted =
            await scopedDb.frameVariants.selectIfPendingPromoteIs(
              frame.id,
              versionId,
              { actorId: input.userId }
            );

          if (promoted) {
            await channel.emit('generation.image:progress', {
              shotId,
              status: 'completed',
              thumbnailUrl: upload.url,
              model,
            });
            logger.info(`[ImageWorkflow] Uploaded + selected: ${upload.path}`);
            return { imageUrl: upload.url };
          }

          // Not the promote target — finalize into history only. Reset in-flight
          // frame status so we don't leave a perpetual generating spinner.
          const settled = await scopedDb.liveRead.frames.getById(frame.id);
          const settleStatus = settled?.selectedImageVersionId
            ? 'completed'
            : 'pending';
          await scopedDb.frames.setImageGenerationStatus(
            frame.id,
            {
              imageStatus: settleStatus,
              imageWorkflowRunId: null,
              imageError: null,
            },
            { throwOnMissing: false }
          );
          // Clear pending only if it still points at us (shouldn't if user
          // cancelled; belt-and-suspenders if claim was stale).
          await scopedDb.frames.clearPendingPromoteVersionIdIf(
            frame.id,
            versionId
          );
          await channel.emit('generation.image:progress', {
            shotId,
            status: settleStatus,
            model,
          });
          logger.info(
            `[ImageWorkflow] Uploaded unselected (pending promote moved): ${upload.path}`
          );
          return { imageUrl: upload.url };
        }
      );
      imageUrl = writeResult.imageUrl;

      // Provenance (#1180) — recorded before the cancel check on purpose: a
      // cancelled render still uploaded bytes to R2, so the object exists and
      // has to be traceable like any other. Its own step so a retry of the
      // persist logic can't double-insert. Throws so a transient D1 failure
      // retries instead of leaving a silent audit gap.
      await step.do('record-provenance', async () => {
        await recordProvenance(scopedDb.provenance, {
          teamId,
          userId: input.userId,
          assetKind: 'frame_variant',
          assetId: generation.versionId || prep.versionId,
          storageKey: buildR2Key(STORAGE_BUCKETS.THUMBNAILS, upload.path),
          provider: imageResult.via,
          model: generation.params.model,
          providerRequestId:
            falUsage.requestId ?? imageResult.metadata.requestId ?? null,
          workflowRunId: event.instanceId,
          prompt: generation.params.prompt,
          sequenceId,
          shotId,
          referenceImageCount:
            generation.params.referenceImageUrls?.length ?? 0,
        });
      });

      if (writeResult.cancelled) {
        return { imageUrl, shotId, sequenceId, cancelled: true };
      }
    } else if (imageUrl && shotId && input.skipStorage) {
      await step.do('record-preview-variant', async () => {
        const anchor = await this.resolveFrame(scopedDb, input);
        if (!anchor) {
          // Reachable only if the frame was deleted mid-run — a missing
          // `frameId` now stands down in `prep`, before spend. Not `info`: the
          // image is already paid for and is about to be discarded.
          logger.warn(
            `[ImageWorkflow] Shot ${shotId} lost its anchor frame mid-run; discarding a preview that was already generated and billed`
          );
          return;
        }

        // A preview is a render of the RAW SCENE TEXT, not of the frame's
        // prompt (#1101) — it exists so something can appear during script
        // analysis, before a prompt version does. So it lands as its own
        // `kind: 'preview'` row: keyed by the scene text it came from, never
        // paired with a prompt version, never selectable or promotable.
        //
        // `skipStorage` still skips the R2 upload, deliberately, to keep the
        // progressive reveal fast (#1091). The url expires; that is harmless
        // precisely because nothing durable can ever point at this row.
        await scopedDb.frameVariants.recordPreview({
          frameId: anchor.id,
          sequenceId: anchor.sequenceId,
          model: generation.params.model,
          url: imageUrl,
          promptHash: generation.prompt ? simpleHash(generation.prompt) : null,
          workflowRunId,
        });

        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            { shotId, previewThumbnailUrl: imageUrl }
          );
        }
      });
    }

    return { imageUrl, shotId, sequenceId };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    if (input.skipStorage) return;
    if (!input.shotId || !input.teamId) return;

    // Variant-only: leave the primary frame untouched on failure too — only
    // this model's in-flight version flips to 'failed' below.
    if (!input.variantOnly) {
      const anchor = await this.resolveFrame(scopedDb, input);
      if (anchor) {
        await scopedDb.frames.setImageGenerationStatus(
          anchor.id,
          { imageStatus: 'failed', imageError: error },
          { throwOnMissing: false }
        );
        // Drop auto-promote if this run owned it (#1070).
        if (anchor.pendingPromoteVersionId) {
          const pending = await scopedDb.claims.frameVariants.getById(
            anchor.pendingPromoteVersionId
          );
          if (pending?.workflowRunId === event.instanceId) {
            await scopedDb.frames.clearPendingPromoteVersionIdIf(
              anchor.id,
              pending.id
            );
          }
        }
      }
    }
    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );

    const model = input.model ?? DEFAULT_IMAGE_MODEL;
    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            shotId: input.shotId,
            status: 'failed',
            model,
            ...(input.variantOnly ? {} : { error }),
            variantOnly: input.variantOnly,
          }
        );
      } catch (emitError) {
        logger.error(
          `[ImageWorkflow] Failed to emit failure event for sequence ${input.sequenceId} shot ${input.shotId}:`,
          { err: emitError }
        );
      }
    }

    if (isContentRejectionError(error)) {
      logger.warn(
        `[ImageWorkflow] frame ${input.shotId} failed a content checker`,
        {
          event: CONTENT_REJECTION_EVENT,
          kind: 'image',
          model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          error,
        }
      );
    }

    logger.error(
      `[ImageWorkflow] Image generation failed for frame ${input.shotId}: ${error}`
    );
  }
}
