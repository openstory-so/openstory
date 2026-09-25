/**
 * The `libraryTalentSheetWorkflow` durable workflow.

 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/billing/server/workflow-deduction';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { ImageGenerationParams } from '@/stills/server/image-generation';
import { buildLibraryTalentSheetPrompt } from '@/cast/character-prompt';
import { cropTalentSheetPortrait } from '@/cast/server/talent/crop-sheet-portrait';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { getTalentChannel } from '@/platform/realtime';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { copyStoredImage } from '@/platform/server/storage/copy-stored-image';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { storeGeneratedPng } from '@/stills/server/image-storage';
import { generateImageSoftening } from '@/stills/server/workflows/content-soften';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult,
} from '@/platform/server/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from './sheet-snapshots';
import { saveDivergentTalentSheet } from './sheet-divergence';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'library-talent-sheet']);

export class LibraryTalentSheetWorkflow extends OpenStoryWorkflowEntrypoint<LibraryTalentSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LibraryTalentSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LibraryTalentSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    await step.do('validate-snapshot', async () => {
      if (input.snapshotInputHash) {
        const expected = input.snapshotInputHash;
        const recomputed = await computeLibraryTalentSheetHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      }
    });

    // Step 1: Validate input. No existence read — both triggers created or
    // loaded the talent row, and the `talent.update` at the end fails loudly on
    // a row that vanished mid-run.
    await step.do('validate-input', async () => {
      if (!input.talentId) {
        throw new WorkflowValidationError('talentId is required');
      }

      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const imageCount = input.referenceImageUrls?.length ?? 0;

      logger.info(
        `[LibraryTalentSheetWorkflow:cf] Starting sheet generation for talent ${input.talentName}${hasReferenceImages ? ` with ${imageCount} reference images` : ' (no reference images - generating from name/description)'}`
      );

      // Emit generating status
      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'generating',
        activity: input.uploadedSheetUrl ? 'portrait' : 'sheet',
      });
    });

    const uploadedSheetUrl = input.uploadedSheetUrl;
    let sheetUsage: { requestId?: string | null } = {};
    let storageResult: { sheetId: string; url: string; path: string };
    const sheetSource = uploadedSheetUrl ? 'manual_upload' : 'ai_generated';

    if (uploadedSheetUrl) {
      storageResult = await step.do('use-uploaded-sheet', async () => {
        logger.info(
          `[LibraryTalentSheetWorkflow:cf] Copying uploaded character sheet for ${input.talentName}`
        );
        // The claimed id (#1113); a pre-#1113 run mints one here.
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        const sheetId = input.sheetId ?? generateId();
        const storagePath = `${input.teamId}/${input.talentId}/${sheetId}.png`;
        const result = await copyStoredImage({
          sourceUrl: uploadedSheetUrl,
          destBucket: STORAGE_BUCKETS.TALENT,
          destPath: storagePath,
        });
        return {
          sheetId,
          url: result.publicUrl,
          path: result.path,
        };
      });
    } else {
      // Step 2: Generate the talent sheet image with references
      const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const generationParams: ImageGenerationParams = {
        model,
        prompt: buildLibraryTalentSheetPrompt(
          input.talentName,
          input.talentDescription,
          hasReferenceImages
        ),
        imageSize: 'landscape_16_9',
        numImages: 1,
        resolution: '1080p',
      } satisfies ImageGenerationParams;

      // Only include referenceImageUrls if provided
      if (hasReferenceImages) {
        generationParams.referenceImageUrls = input.referenceImageUrls;
      }

      // Reseeds on a content flag, then one softened prompt (#1293).
      const generation = await generateImageSoftening({
        step,
        scopedDb,
        workflowRunId: event.instanceId,
        userId: input.userId,
        kind: 'talent-sheet',
        logTag: '[LibraryTalentSheetWorkflow:cf]',
        subject: `sheet${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`,
        stepName: 'generate-sheet-image',
        params: generationParams,
        meta: { talentId: input.talentId },
        store: async (result) => {
          // The claimed id (#1113) becomes the sheet row's id. A pre-#1113
          // run mints it inside the step so it survives replay.
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
          const sheetId = input.sheetId ?? generateId();
          const stored = await storeGeneratedPng(
            result.imageUrls[0],
            STORAGE_BUCKETS.TALENT,
            `${input.teamId}/${input.talentId}/${sheetId}.png`
          );
          return { sheetId, ...stored };
        },
      });
      const stored = generation.stored;
      if (!stored.sheetId) {
        throw new Error('Talent sheet store must return sheetId');
      }
      storageResult = {
        sheetId: stored.sheetId,
        url: stored.url,
        path: stored.path,
      };
      const imageMetadata = generation.metadata;

      // Before the deduction guard — see recordFalUsageStep (#1069).
      sheetUsage = await recordFalUsageStep(
        step,
        scopedDb,
        imageMetadata,
        'record-fal-usage-sheet'
      );

      // Deduct credits for sheet generation (skip if team used own fal key)
      await step.do('deduct-credits-sheet', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: extractImageCost(imageMetadata),
          usedOwnKey: imageMetadata.usedOwnKey,
          description: `Talent sheet (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
          idempotencyKey: `${event.instanceId}:sheet`,
          metadata: {
            ...sheetUsage,
            talentId: input.talentId,
            type: 'sheet',
          },
          workflowName: 'LibraryTalentSheetWorkflow',
        });
      });
    }

    // Step 4: Land the sheet through the claim (#1113). The row is always
    // written (the artifact is in R2 either way); it becomes the talent's
    // live sheet only while the trigger's claim still names it. A missed
    // claim — the name, description or photos edited mid-run, a newer run, or
    // the user picking a sheet — parks it as divergent and stops before the
    // headshot, so a stale run cannot overwrite the talent's identity.
    const sheetReconcile = await step.do(
      'reconcile-create-sheet',
      async (): Promise<{
        kind: 'convergent' | 'divergent';
        sheet: Awaited<ReturnType<typeof scopedDb.talent.sheets.create>>;
      }> => {
        const sheetFields = {
          talentId: input.talentId,
          name: input.sheetName ?? 'Generated Sheet',
          imageUrl: storageResult.url,
          imagePath: storageResult.path,
          metadata: input.uploadedSheetMetadata,
          source: sheetSource,
          inputHash: input.snapshotInputHash ?? null,
        } as const;

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        if (!input.sheetId) {
          // Pre-#1113 run: lands unconditionally. The pre-check makes a step
          // retry reuse the row it already created under the stable PK.
          const existing = await scopedDb.talent.sheets.getById(
            storageResult.sheetId
          );
          const sheet =
            existing ??
            (await scopedDb.talent.sheets.create({
              ...sheetFields,
              id: storageResult.sheetId,
              // Generated rows never auto-take the Default badge; a first
              // upload does (`sheets.create` promotes when omitted).
              ...(sheetSource !== 'manual_upload' ? { isDefault: false } : {}),
            }));
          return { kind: 'convergent', sheet };
        }

        const { sheet, landed } = await scopedDb.talent.landSheet({
          ...sheetFields,
          sheetId: input.sheetId,
        });
        if (landed) return { kind: 'convergent', sheet };

        logger.warn('[LibraryTalentSheetWorkflow:cf] claim moved; parked', {
          talentId: input.talentId,
          sheetId: sheet.id,
          storagePath: storageResult.path,
        });
        await saveDivergentTalentSheet({
          scopedDb,
          talentSheetId: sheet.id,
          talentId: input.talentId,
          model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
          url: storageResult.url,
          storagePath: storageResult.path,
          workflowRunId,
          snapshotInputHash:
            input.snapshotInputHash ??
            (await computeLibraryTalentSheetHashFromDto(input)),
        });
        return { kind: 'divergent', sheet };
      }
    );

    const sheet = sheetReconcile.sheet;

    // Provenance (#1180) — recorded on divergent runs too: the sheet is in R2
    // even when it does not become the talent's primary. Own step so a retry
    // of the later headshot path cannot double-insert.
    await step.do('record-sheet-provenance', async () => {
      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'talent_sheet',
        assetId: sheet.id,
        storageKey: storageResult.path,
        provider: sheetSource === 'manual_upload' ? 'upload' : 'fal',
        model:
          sheetSource === 'manual_upload'
            ? 'manual-upload'
            : (input.imageModel ?? DEFAULT_IMAGE_MODEL),
        providerRequestId: sheetUsage.requestId ?? null,
        workflowRunId,
        prompt: buildLibraryTalentSheetPrompt(
          input.talentName,
          input.talentDescription,
          Boolean(hasReferenceImages)
        ),
        referenceImageCount: input.referenceImageUrls?.length ?? 0,
      });
    });

    if (sheetReconcile.kind === 'divergent') {
      // Helper already emitted `stale:detected` on the talent channel.
      // Stop here: do not generate the headshot or update talent.imageUrl,
      // so a now-stale run cannot overwrite the talent's primary identity.
      // The talent_sheets row was created with `isDefault: false` (and
      // `talent.sheets.create` honors the explicit false even when the talent
      // has no other sheets), so it shows up in the talent's sheet list
      // without becoming the talent's primary image. Emit a terminal
      // `talent.sheet:progress` so the UI clears its "Generating sheet…"
      // spinner — without this the hook would stay stuck because it only
      // releases on `completed` or `failed`.
      await step.do('emit-divergent-settled', async () => {
        // Omit `sheetImageUrl` from the divergent-completed event so any
        // future subscriber that reads the payload directly (instead of
        // refetching via the hook's query invalidation) cannot mistake the
        // divergent variant URL for the talent's live primary image.
        // `talentId` is guarded non-null at the workflow's `validate-input`
        // step, so `getTalentChannel` always returns a real channel here.
        await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
          talentId: input.talentId,
          status: 'completed',
          sheetId: sheet.id,
        });
      });
      logger.info(
        `[LibraryTalentSheetWorkflow:cf] Diverged for ${input.talentName}; saved as variant`
      );
      return {
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
        sheetImagePath: storageResult.path,
      };
    }

    // Emit sheet_ready so the UI can show the sheet while the portrait crop runs.
    await step.do('emit-sheet-ready', async () => {
      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'sheet_ready',
        activity: 'portrait',
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
      });
    });

    // Portrait is panel 2 of the 4-panel — crop it instead of a second
    // gpt_image_2 call (measured ~2 min and not even conditioned on the sheet).
    const headshotStorageResult = await step.do('crop-headshot', async () => {
      logger.info(
        `[LibraryTalentSheetWorkflow:cf] Cropping portrait panel for ${input.talentName}`
      );
      const result = await cropTalentSheetPortrait({
        sheetUrl: storageResult.url,
        destPath: `${input.teamId}/${input.talentId}/headshot.png`,
      });
      return {
        url: result.publicUrl,
        path: result.path,
      };
    });

    await step.do('record-headshot-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'talent_sheet',
        assetId: `${sheet.id}#headshot`,
        storageKey: headshotStorageResult.path,
        provider: 'internal',
        model: 'crop-sheet-portrait',
        providerRequestId: null,
        workflowRunId,
        prompt: 'Crop close-up panel from talent sheet',
        referenceImageCount: 1,
      });
    });

    // Step 7: Update talent with headshot
    await step.do('update-talent-headshot', async () => {
      logger.info(
        `[LibraryTalentSheetWorkflow:cf] Updating talent with headshot`
      );

      await scopedDb.talent.update(input.talentId, {
        imageUrl: headshotStorageResult.url,
        imagePath: headshotStorageResult.path,
      });
    });

    // Emit completed status
    await step.do('emit-completed', async () => {
      logger.info(
        `[LibraryTalentSheetWorkflow:cf] Talent sheet workflow completed for ${input.talentName}`
      );

      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'completed',
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
        headshotImageUrl: headshotStorageResult.url,
      });
    });

    return {
      sheetId: sheet.id,
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      headshotImageUrl: headshotStorageResult.url,
      headshotImagePath: headshotStorageResult.path,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<LibraryTalentSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Clear this run's claim only while it still holds it (#1113).
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
    if (input.sheetId) {
      await scopedDb.talent.clearSheetClaimIf(input.talentId, input.sheetId);
    }

    logger.error(
      `[LibraryTalentSheetWorkflow:cf] Sheet generation failed for talent ${input.talentName}: ${error}`
    );

    // Emit failed status
    await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
      talentId: input.talentId,
      status: 'failed',
      error: `Sheet generation failed: ${error}`,
    });
  }
}
