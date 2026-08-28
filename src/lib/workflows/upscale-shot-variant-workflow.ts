/**
 * Upscale a chosen 3×3 grid tile into the frame's primary still (#989).
 *
 * The picked tile is cropped by `selectShotVariantFn`, which mints a
 * `kind:'framing'` generating version (crop url already on the row) and
 * claims auto-promote. This workflow completes THAT version — it does not
 * append a second generating row — then promotes it to the frame's still.
 * The promote rides the auto-promote claim (#1070/#1129), so a still the
 * user picked from history mid-upscale wins and the upscale lands in history
 * instead.
 */

import { IMAGE_MODELS } from '@/lib/ai/models';
import { resolveUpscaleModel } from '@/lib/ai/resolve-asset-models';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import {
  aspectRatioToImageSize,
  DEFAULT_IMAGE_SIZE,
} from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { recordProvenance } from '@/lib/compliance/provenance';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { buildR2Key, STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getAnchorImageUrl } from '@/lib/shots/frame-image';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'upscale-shot-variant']);

const UPSCALE_PROMPT = `Upscale this image to a clean, high-resolution shot suitable for animation.

RENDERING RULES
- Keep the original scene, pose, framing and camera angle IDENTICAL.
- Preserve the identity of all real people:
  - Do NOT change their faces, expressions, hairstyles, or clothing.
  - Do NOT add new people or remove existing people.
- Faces:
  - Make faces sharp and detailed.
  - Clear eyes, natural skin texture, no plastic or over-smoothed look.
- Text & logos:
  - Preserve all printed text, signage, and logos exactly as they appear.
  - Re-render text cleanly at higher resolution.
  - Do NOT invent new words, change names, or move signs.
- Style:
  - Realistic photographic look.
  - Keep original colours, lighting and depth of field.
  - No extra filters, bokeh, vignettes, film grain, or stylistic changes unless they already exist.

OUTPUT
- A SINGLE high-resolution image.
- Aspect ratio: match the original exactly.
- Resolution: upscale to animation-ready quality.
- No text overlays, borders, watermarks, or new graphics added by the model.`;

/**
 * The frame/variant writes `persistUpscaleSelection` needs — a narrow slice of
 * {@link ScopedDb} so unit tests can inject a small spy. `Pick`ed off the real
 * thing rather than hand-written, per scoped-workflow.ts: the signatures stay
 * in lockstep with the query module instead of restating it.
 *
 * What this still does NOT catch is a change in RETURN semantics — e.g.
 * `selectIfPendingPromoteIs` returning the current selection instead of `null`
 * on a miss would keep compiling and silently turn every claim miss into a
 * wrong-thumbnail promote. The `…If` naming convention is the only guard there.
 */
export type BindUpscaleVersionScopedDb = {
  claims: {
    frameVariants: Pick<WorkflowScopedDb['claims']['frameVariants'], 'getById'>;
  };
  frameVariants: Pick<ScopedDb['frameVariants'], 'update' | 'appendVersion'>;
  frames: Pick<ScopedDb['frames'], 'setPendingPromoteVersionId'>;
};

export async function bindUpscaleVersion(params: {
  scopedDb: BindUpscaleVersionScopedDb;
  versionId: string | undefined;
  frameId: string;
  sequenceId: string;
  upscaleModel: string;
  sourceVariantId: string | null;
  promptVersionId: string | null | undefined;
  workflowRunId: string;
}): Promise<string | null> {
  const {
    scopedDb,
    versionId,
    frameId,
    sequenceId,
    upscaleModel,
    sourceVariantId,
    promptVersionId,
    workflowRunId,
  } = params;
  if (versionId) {
    const existing = await scopedDb.claims.frameVariants.getById(versionId);
    if (!existing) return null;
    await scopedDb.frameVariants.update(existing.id, { workflowRunId });
    return existing.id;
  }
  const version = await scopedDb.frameVariants.appendVersion({
    frameId,
    sequenceId,
    kind: 'framing',
    model: upscaleModel,
    sourceVariantId,
    promptVersionId,
    status: 'generating',
    workflowRunId,
  });
  await scopedDb.frames.setPendingPromoteVersionId(frameId, version.id);
  return version.id;
}

export type PersistUpscaleScopedDb = {
  frameVariants: Pick<
    ScopedDb['frameVariants'],
    'update' | 'selectIfPendingPromoteIs'
  >;
  frames: Pick<ScopedDb['frames'], 'setImageGenerationStatus'>;
  liveRead: {
    frames: Pick<WorkflowScopedDb['liveRead']['frames'], 'getById'>;
  };
};

type UpscaleImageProgress = {
  shotId: string;
  status: 'completed';
  thumbnailUrl?: string;
};

/**
 * Two-outcome result of the promote, mirroring `PersistMotionOutcome`
 * (motion-workflow-persist.ts). The "a promoted upscale always has a still"
 * invariant lives HERE rather than on the emit payload: the wire schema
 * (`image:progress`) has to keep `thumbnailUrl` optional because the claim-miss
 * emit deliberately omits it, so the outcome type is the only place the pairing
 * is actually true.
 */
export type UpscalePromoteOutcome =
  | { promoted: true; thumbnailUrl: string }
  | { promoted: false };

/**
 * Complete the in-flight upscaled framing version and promote it to the frame's
 * primary still THROUGH the auto-promote claim minted at kickoff (#1129) — the
 * same door every other primary-still writer uses (#1070). A bare
 * `frameVariants.select` here would clobber a still the user picked from
 * history while the upscale ran (minutes); the claim encodes *later intent
 * wins*, and that manual pick clears it.
 *
 * A claim miss — the user selected something else, or a newer kickoff took the
 * claim — finalizes the upscale into history instead. Nothing is lost: the row
 * stays selectable from the picker.
 *
 * A frame deleted mid-flight is NOT this path: `frames.id` cascades to
 * `frame_variants`, so the version row is gone too and the `update` above
 * throws before the claim is ever consulted. That surfaces as a run failure,
 * which is what the old explicit existence check here could never actually
 * catch — the same `update` threw first.
 *
 * Extracted from the workflow's `select-upscaled-version` step so the promote
 * outcome is unit-testable without the fal/storage/credit steps. The frame is
 * the trigger's (frame id ≠ shot id, #989) — resolving the anchor here would
 * let a mid-run anchor change move the still onto a different frame than the
 * run claimed.
 */
export async function persistUpscaleSelection(params: {
  scopedDb: PersistUpscaleScopedDb;
  shotId: string;
  frameId: string;
  versionId: string;
  url: string;
  path: string | null;
  actorId: string;
  generatedAt: Date;
  emit: (payload: UpscaleImageProgress) => Promise<void>;
}): Promise<UpscalePromoteOutcome> {
  const {
    scopedDb,
    shotId,
    frameId,
    versionId,
    url,
    path,
    actorId,
    generatedAt,
    emit,
  } = params;

  await scopedDb.frameVariants.update(versionId, {
    status: 'completed',
    url,
    storagePath: path,
    generatedAt,
    error: null,
  });

  const promoted = await scopedDb.frameVariants.selectIfPendingPromoteIs(
    frameId,
    versionId,
    { actorId }
  );

  if (!promoted) {
    logger.info(
      `[UpscaleShotVariantWorkflow] Promote claim on frame ${frameId} moved; upscale ${versionId} stays in history`
    );
    // Kickoff flipped imageStatus to generating. If a newer run owns the
    // claim, leave the spinner — that run is still in flight. If the claim
    // is gone (history select), settle back to the selected still, never
    // `failed` — the old still is still good.
    const frameNow = await scopedDb.liveRead.frames.getById(frameId);
    if (frameNow && !frameNow.pendingPromoteVersionId) {
      await scopedDb.frames.setImageGenerationStatus(
        frameId,
        {
          imageStatus: frameNow.selectedImageVersionId
            ? 'completed'
            : 'pending',
          imageWorkflowRunId: null,
          imageError: null,
        },
        { throwOnMissing: false }
      );
      await emit({ shotId, status: 'completed' });
    }
    return { promoted: false };
  }

  await emit({ shotId, status: 'completed', thumbnailUrl: url });
  return { promoted: true, thumbnailUrl: url };
}

export class UpscaleShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<UpscaleShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<UpscaleShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const { sequenceId, teamId, shotId, userId } = input;
    if (!sequenceId || !teamId || !shotId) {
      throw new WorkflowValidationError('sequenceId and teamId are required');
    }

    // Derived from the payload, so it survives a step replay unchanged.
    const upscaleModel = resolveUpscaleModel(input.sourceModel);

    logger.info(
      `[UpscaleShotVariantWorkflow] Starting upscale for shot ${shotId} with model ${upscaleModel}`
    );

    const upscaleResult = await step.do('upscale-image', async () => {
      // The frame is the trigger's (payload `frameId`) — checked for existence,
      // never re-resolved, so both this step and the select step write to the
      // same frame.
      const frame = await scopedDb.liveRead.frames.getById(input.frameId);
      if (!frame) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Frame ${input.frameId} (shot ${shotId}) is gone, skipping`
        );
        return null;
      }

      const versionId = await bindUpscaleVersion({
        scopedDb,
        versionId: input.versionId,
        frameId: frame.id,
        sequenceId,
        upscaleModel,
        sourceVariantId: input.sourceVariantId ?? null,
        promptVersionId: input.promptVersionId,
        workflowRunId,
      });
      if (!versionId) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Version ${input.versionId} is gone, skipping`
        );
        return null;
      }

      // Same primary-busy flag image gen uses. Trigger already flipped this
      // when it minted the version; stamp the run id here so legacy payloads
      // and a race before the trigger's post-create write still show busy.
      // Failure/claim-miss settle back to `completed` (the old still stays
      // selected — never `failed`).
      await scopedDb.frames.setImageGenerationStatus(
        frame.id,
        {
          imageStatus: 'generating',
          imageWorkflowRunId: workflowRunId,
          imageError: null,
        },
        { throwOnMissing: false }
      );

      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        shotId,
        status: 'generating',
      });

      // The cropped tile rides through the builder as the primary reference so
      // the prompt's Image numbering matches the image_urls array — prepending
      // it afterwards would shift every legend/inline binding off by one.
      const allReferences = [
        {
          referenceImageUrl: input.croppedTileUrl,
          description: 'The source shot to upscale — the output is this image',
          role: 'primary' as const,
        },
        ...(input.characterReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('character' as const),
        })),
        ...(input.locationReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('location' as const),
        })),
      ];
      const { prompt: enhancedPrompt, referenceUrls } =
        buildReferenceImagePrompt(
          UPSCALE_PROMPT,
          allReferences,
          IMAGE_MODELS[upscaleModel].maxPromptLength
        );

      const imageSize = input.aspectRatio
        ? aspectRatioToImageSize(input.aspectRatio)
        : DEFAULT_IMAGE_SIZE;

      const result = await generateImageWithProvider(
        {
          model: upscaleModel,
          prompt: enhancedPrompt,
          imageSize,
          referenceImageUrls: referenceUrls,
          numImages: 1,
          outputFormat: 'png',
        },
        { scopedDb: scopedDb.credentials }
      );
      return {
        imageUrl: result.imageUrls[0],
        cost: result.metadata.cost ?? ZERO_MICROS,
        usedOwnKey: result.metadata.usedOwnKey,
        endpointId: result.metadata.endpointId,
        unitsBilled: result.metadata.unitsBilled,
        versionId,
      };
    });

    if (!upscaleResult) {
      return { upscaledUrl: '', upscaledPath: '' };
    }

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(step, scopedDb, upscaleResult);

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: upscaleResult.cost,
        usedOwnKey: upscaleResult.usedOwnKey,
        description: `Variant upscale (${upscaleModel})`,
        idempotencyKey: `${event.instanceId}:upscale`,
        metadata: {
          ...falUsage,
          shotId,
          sequenceId,
          model: upscaleModel,
        },
        workflowName: 'UpscaleShotVariantWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      if (!upscaleResult.imageUrl) {
        throw new Error('Upscale did not return an image URL');
      }
      const result = await uploadImageToStorage({
        imageUrl: upscaleResult.imageUrl,
        teamId,
        sequenceId,
        shotId,
      });
      if (!result.url) {
        throw new Error('Failed to upload upscaled image to storage');
      }
      return { url: result.url, path: result.path };
    });

    // Provenance (#1180). The upscale is a new frame_variant in R2 — same
    // kind as a still, different persist path. Recorded before select so a
    // cancelled/failed pointer flip cannot leave an untraceable object.
    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId,
        assetKind: 'frame_variant',
        assetId: upscaleResult.versionId,
        storageKey: buildR2Key(STORAGE_BUCKETS.THUMBNAILS, storageResult.path),
        provider: 'fal',
        model: upscaleModel,
        providerRequestId: falUsage.requestId ?? null,
        workflowRunId,
        prompt: UPSCALE_PROMPT,
        sequenceId,
        shotId,
        referenceImageCount:
          1 +
          (input.characterReferences?.length ?? 0) +
          (input.locationReferences?.length ?? 0),
      });
    });

    await step.do('select-upscaled-version', async () => {
      // Completes the version, then promotes it through this run's claim.
      const outcome = await persistUpscaleSelection({
        scopedDb,
        shotId,
        frameId: input.frameId,
        versionId: upscaleResult.versionId,
        url: storageResult.url,
        path: storageResult.path || null,
        actorId: userId,
        generatedAt: new Date(),
        emit: (payload) =>
          getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            payload
          ),
      });

      if (outcome.promoted) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Upscale completed + selected for shot ${shotId}: ${outcome.thumbnailUrl}`
        );
      }
    });

    return {
      upscaledUrl: storageResult.url,
      upscaledPath: storageResult.path || '',
    } satisfies UpscaleShotVariantWorkflowResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    logger.error(
      `[UpscaleShotVariantWorkflow] Upscale failed for shot ${input.shotId}: ${error}`
    );
    if (!input.shotId || !input.teamId) return;

    // Mark the in-flight framing version failed; the frame's PRIOR selection is
    // untouched, so revert the UI to the real selected still rather than showing
    // a false failure on a good image. Prefer the snapshotted version id so a
    // run that dies before `workflowRunId` is stamped still settles.
    if (input.versionId) {
      const minted = await scopedDb.claims.frameVariants.getById(
        input.versionId
      );
      if (minted?.status === 'generating' || minted?.status === 'pending') {
        await scopedDb.frameVariants.update(input.versionId, {
          status: 'failed',
          error,
        });
      }
    } else {
      await scopedDb.frameVariants.markFailedByWorkflowRun(
        event.instanceId,
        error
      );
    }

    // Drop the auto-promote claim, but only if THIS run still owns it (#1129) —
    // a newer kickoff's claim must survive an older upscale's failure.
    const frame = await scopedDb.liveRead.frames.getById(input.frameId);
    if (frame?.pendingPromoteVersionId) {
      const pending = await scopedDb.claims.frameVariants.getById(
        frame.pendingPromoteVersionId
      );
      if (pending?.workflowRunId === event.instanceId) {
        await scopedDb.frames.clearPendingPromoteVersionIdIf(
          frame.id,
          pending.id
        );
      }
    }
    // Settle the primary-busy flag only if this run set it. A newer upscale
    // owns `imageWorkflowRunId` / the spinner; don't wipe that. Never `failed`
    // — the selected still is still good.
    if (frame?.imageWorkflowRunId === event.instanceId) {
      await scopedDb.frames.setImageGenerationStatus(
        frame.id,
        {
          imageStatus: frame.selectedImageVersionId ? 'completed' : 'pending',
          imageWorkflowRunId: null,
          imageError: null,
        },
        { throwOnMissing: false }
      );
    }

    if (input.sequenceId) {
      // A failed upscale never promoted, so the frame still points at whatever
      // it did before; read that still off the selected version rather than a
      // frame column (#1067).
      const thumbnailUrl = await getAnchorImageUrl(
        scopedDb.liveRead,
        input.shotId
      );
      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        {
          shotId: input.shotId,
          status: 'completed',
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        }
      );
    }
  }
}
