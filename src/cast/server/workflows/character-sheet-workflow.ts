/**
 * The `characterSheetWorkflow` durable workflow.

 */

import {
  CONTENT_REJECTION_EVENT,
  isContentRejectionError,
} from '@/models/content-rejection';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/billing/server/workflow-deduction';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { ImageGenerationParams } from '@/stills/server/image-generation';
import { buildCharacterSheetPrompt } from '@/cast/character-prompt';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { getGenerationChannel } from '@/platform/realtime';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { copyStoredImage } from '@/platform/server/storage/copy-stored-image';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { storeGeneratedPng } from '@/stills/server/image-storage';
import { generateImageSoftening } from '@/stills/server/workflows/content-soften';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
} from '@/platform/server/workflow/types';
import { reportParkedCharacterSheet } from './sheet-divergence';
import { characterSheetHashMatchesStored } from './sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'character-sheet']);

type SheetLanding =
  | { kind: 'convergent'; versionId: string | null }
  | { kind: 'divergent' };

/**
 * Land the sheet through the claim the trigger took (#1113): select it only
 * while the claim still names it, else park it as divergent and tell the UI.
 * A run queued before #1113 carries no claim and lands unconditionally, as it
 * did before minus the write-time hash recheck.
 */
async function landSheet(
  scopedDb: WorkflowScopedDb,
  input: CharacterSheetWorkflowInput,
  stored: { url: string; path: string; model: string },
  workflowRunId: string
): Promise<SheetLanding> {
  const sequenceId = input.sequenceId;
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
  if (!input.sheetVersionId || !sequenceId) {
    const character = await scopedDb.characters.updateSheet(
      input.characterDbId,
      stored.url,
      stored.path,
      input.snapshotInputHash ?? null,
      { model: stored.model, workflowRunId }
    );
    return { kind: 'convergent', versionId: character.selectedSheetVersionId };
  }
  const landing = await scopedDb.characterSheetVariants.promoteIfPending({
    characterId: input.characterDbId,
    versionId: input.sheetVersionId,
    url: stored.url,
    storagePath: stored.path,
    inputHash: input.snapshotInputHash ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload queued before #1600
    bibleVersionId: input.bibleVersionId ?? null,
    model: stored.model,
    workflowRunId,
  });
  if (landing === 'promoted') {
    return { kind: 'convergent', versionId: input.sheetVersionId };
  }
  logger.warn('[CharacterSheetWorkflow:cf] claim moved; sheet parked', {
    characterDbId: input.characterDbId,
    versionId: input.sheetVersionId,
    storagePath: stored.path,
  });
  await reportParkedCharacterSheet({
    sequenceId,
    characterId: input.characterDbId,
    versionId: input.sheetVersionId,
    snapshotInputHash: input.snapshotInputHash,
  });
  return { kind: 'divergent' };
}

async function persistReusedTalentSheet(params: {
  event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>;
  step: WorkflowStep;
  scopedDb: WorkflowScopedDb;
  input: CharacterSheetWorkflowInput;
  workflowRunId: string;
}): Promise<CharacterSheetWorkflowResult> {
  const { step, scopedDb, input, workflowRunId } = params;
  const sourceUrl = input.referenceImageUrl;
  if (!sourceUrl) {
    throw new WorkflowValidationError(
      'reuseTalentSheet requires referenceImageUrl'
    );
  }
  if (!input.characterDbId || !input.teamId || !input.sequenceId) {
    throw new WorkflowValidationError(
      'reuseTalentSheet requires characterDbId, teamId, and sequenceId'
    );
  }
  const characterDbId = input.characterDbId;
  const sequenceId = input.sequenceId;

  const storageResult = await step.do('copy-talent-sheet', async () => {
    logger.info(
      `[CharacterSheetWorkflow:cf] Reusing talent sheet for ${input.characterName}`
    );
    const uniqueId = generateId();
    const storagePath = `${input.teamId}/${sequenceId}/${characterDbId}/${uniqueId}.png`;
    const result = await copyStoredImage({
      sourceUrl,
      destBucket: STORAGE_BUCKETS.CHARACTERS,
      destPath: storagePath,
    });
    return {
      url: result.publicUrl,
      path: result.path,
    };
  });

  await step.do('record-provenance', async () => {
    await recordProvenance(scopedDb.provenance, {
      teamId: input.teamId,
      userId: input.userId,
      assetKind: 'character_sheet',
      assetId: characterDbId,
      storageKey: storageResult.path,
      provider: 'internal',
      model: 'reuse-talent-sheet',
      providerRequestId: null,
      workflowRunId,
      prompt: 'Reuse uploaded/library talent sheet without regeneration',
      sequenceId,
      referenceImageCount: 1,
    });
  });

  const reconcileOutcome = await step.do('reconcile-database', () =>
    landSheet(
      scopedDb,
      input,
      {
        url: storageResult.url,
        path: storageResult.path,
        model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
      },
      workflowRunId
    )
  );

  if (reconcileOutcome.kind === 'divergent') {
    await step.do('settle-divergent-status', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.character-sheet:progress',
        {
          characterId: characterDbId,
          status: 'completed',
        }
      );
    });
    return {
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      characterDbId,
      diverged: true,
    };
  }

  await step.do('emit-complete-event', async () => {
    await getGenerationChannel(sequenceId).emit(
      'generation.character-sheet:progress',
      {
        characterId: characterDbId,
        status: 'completed',
        sheetImageUrl: storageResult.url,
      }
    );
  });

  return {
    sheetImageUrl: storageResult.url,
    sheetImagePath: storageResult.path,
    characterDbId,
    sheetVersionId: reconcileOutcome.versionId,
  };
}

export class CharacterSheetWorkflow extends OpenStoryWorkflowEntrypoint<CharacterSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<CharacterSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    // Validate the snapshot hash inside the workflow body: a tampered
    // payload must halt the run from inside a step, not silently.
    await step.do('validate-snapshot', async () => {
      if (input.snapshotInputHash) {
        // Accepts the pre-#1785 shape too, so a run queued before the
        // hash grew a channel does not read as tampered.
        if (
          !(await characterSheetHashMatchesStored(
            input.snapshotInputHash,
            input
          ))
        ) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'generating',
          }
        );
      }
    });

    if (input.reuseTalentSheet) {
      return persistReusedTalentSheet({
        event,
        step,
        scopedDb,
        input,
        workflowRunId,
      });
    }

    // Step 1: Validate and build prompt
    const builtParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.characterMetadata) {
          throw new WorkflowValidationError('characterMetadata is required');
        }

        const hasTalent = !!(input.talentMetadata || input.talentDescription);
        logger.info(
          `[CharacterSheetWorkflow:cf] Starting sheet generation for character ${input.characterName}${hasTalent ? ' with talent appearance' : ''}`
        );

        // Build talent overrides if talent data is provided (for casting)
        const talentOverrides = hasTalent
          ? {
              sheetMetadata: input.talentMetadata,
              description: input.talentDescription,
              sheetImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with character identity + talent appearance + sequence style
        const { prompt, referenceUrls } = buildCharacterSheetPrompt(
          input.characterMetadata,
          talentOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Character sheets use landscape aspect ratio for multi-panel layout
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use talent reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Destination is resolved BEFORE generating, because the image is stored
    // inside the generating step (#1645). `characterDbId` and `teamId` are
    // required on the payload; `sequenceId` is optional on the shared context
    // but the trigger always sets it, and the run cannot write its row or
    // emit progress without it.
    const characterDbId = input.characterDbId;
    const teamId = input.teamId;
    const sequenceId = input.sequenceId;
    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }

    // Step 2: Generate the sheet — same-model reseeds on a content flag
    // (#881/#939), then one softened prompt (#1293). The sheet anchors a
    // character's identity across cuts (#801), so exhaustion is a HARD
    // failure: throw rather than persist a null sheet and render the
    // character unanchored (#939).
    const generation = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId,
      userId: input.userId,
      sequenceId: input.sequenceId,
      reservationId: input.reservationId,
      kind: 'character-sheet',
      logTag: '[CharacterSheetWorkflow:cf]',
      subject: `sheet for ${input.characterName}`,
      stepName: 'generate-sheet-image',
      params: builtParams,
      meta: { characterDbId },
      store: (result) =>
        storeGeneratedPng(
          result.imageUrls[0],
          STORAGE_BUCKETS.CHARACTERS,
          `${teamId}/${sequenceId}/${characterDbId}/${generateId()}.png`
        ),
      onRetry: async (retry) => {
        await getGenerationChannel(sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'generating',
            phase: 'retrying',
            ...retry,
          }
        );
      },
    });
    const storageResult = generation.stored;
    const imageMetadata = generation.metadata;
    const generationParams = generation.params;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(step, scopedDb, imageMetadata);

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageMetadata),
        usedOwnKey: imageMetadata.usedOwnKey,
        description: `Character sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        reservationId: input.reservationId,
        metadata: {
          ...falUsage,
          model: generationParams.model,
          characterName: input.characterName,
          characterDbId: input.characterDbId,
        },
        workflowName: 'CharacterSheetWorkflow',
      });
    });

    let sheetImageUrl: string = storageResult.url;
    const sheetImagePath: string = storageResult.path;
    let sheetVersionId: string | null = null;

    // Provenance (#1180) — recorded even when the run later diverges: the
    // sheet is in R2 either way. Own step so a retry of reconcile cannot
    // double-insert.
    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'character_sheet',
        assetId: characterDbId,
        storageKey: storageResult.path,
        provider: 'fal',
        model: generationParams.model,
        providerRequestId: falUsage.requestId ?? null,
        workflowRunId,
        prompt: generationParams.prompt,
        sequenceId,
        referenceImageCount: generationParams.referenceImageUrls?.length ?? 0,
      });
    });

    // Step 4: Land through the claim (#1113). Selected only while the
    // trigger's claim still names this run; otherwise parked as a divergent
    // variant (and `stale:detected` emitted) so a run whose inputs moved, or
    // that a newer kickoff superseded, cannot overwrite the live sheet.
    const reconcileOutcome = await step.do('reconcile-database', () =>
      landSheet(
        scopedDb,
        input,
        {
          url: storageResult.url,
          path: storageResult.path,
          model: generationParams.model,
        },
        workflowRunId
      )
    );
    if (reconcileOutcome.kind === 'convergent') {
      sheetVersionId = reconcileOutcome.versionId;
    }

    if (reconcileOutcome.kind === 'divergent') {
      // `stale:detected` is out. The land batch already settled the status
      // to `completed` unless a newer run holds the claim. The live sheet (if
      // any) is untouched; a first-time sheet stays empty until the user picks
      // the parked one or regenerates.
      await step.do('settle-divergent-status', async () => {
        await getGenerationChannel(sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: characterDbId,
            status: 'completed',
          }
        );
      });
      logger.info(
        `[CharacterSheetWorkflow:cf] Diverged for ${input.characterName}; saved as variant`
      );
      return {
        sheetImageUrl,
        sheetImagePath,
        characterDbId: input.characterDbId,
        diverged: true,
      };
    }
    // Emit realtime event that generation is complete
    await step.do('emit-complete-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'completed',
            sheetImageUrl,
          }
        );
      }
    });

    const result: CharacterSheetWorkflowResult = {
      sheetImageUrl,
      sheetImagePath,
      characterDbId: input.characterDbId,
      sheetVersionId,
    };

    return result;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Mark character sheet as failed — through the claim, so a newer run's
    // claim and `generating` status survive this one's failure (#1113).
    if (input.characterDbId) {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
      if (input.sheetVersionId) {
        await scopedDb.characters.failSheetClaim(
          input.characterDbId,
          input.sheetVersionId,
          error
        );
      } else {
        await scopedDb.characters.updateSheetStatus(
          input.characterDbId,
          'failed',
          error
        );
      }

      // Emit failure event for realtime UI update
      if (input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'failed',
            error,
          }
        );
      }

      if (isContentRejectionError(error)) {
        // Mirror image/motion `onFailure` so "how many sheets failed a content
        // checker" is one queryable PostHog Logs metric across all three paths.
        logger.warn(
          `[CharacterSheetWorkflow:cf] character ${input.characterDbId} sheet failed a content checker`,
          {
            event: CONTENT_REJECTION_EVENT,
            kind: 'character-sheet',
            model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
            characterDbId: input.characterDbId,
            sequenceId: input.sequenceId,
            error,
          }
        );
      }

      logger.error(
        `[CharacterSheetWorkflow:cf] Sheet generation failed for character ${input.characterName}: ${error}`
      );
    }
  }
}
