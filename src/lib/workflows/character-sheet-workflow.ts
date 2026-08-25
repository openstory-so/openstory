/**
 * Cloudflare Workflows port of `characterSheetWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/character-sheet-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension. */

import {
  CONTENT_REJECTION_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import { buildCharacterSheetPrompt } from '@/lib/prompts/character-prompt';
import { recordProvenance } from '@/lib/compliance/provenance';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { copyStoredImage } from '@/lib/storage/copy-stored-image';
import { uploadResponse } from '@/lib/storage/upload-response';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { generateImageSoftening } from '@/lib/workflows/content-soften';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  decideSheetDivergence,
  saveDivergentCharacterSheet,
} from '@/lib/workflows/sheet-divergence';
import {
  computeCharacterSheetHashCurrent,
  computeCharacterSheetHashFromDto,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'character-sheet']);

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

  const snapshotInputHash = input.snapshotInputHash ?? null;
  const reconcileOutcome = await step.do(
    'reconcile-database',
    async (): Promise<{ kind: 'convergent' } | { kind: 'divergent' }> => {
      const currentHash = snapshotInputHash
        ? await computeCharacterSheetHashCurrent(input, scopedDb.liveRead)
        : null;
      const decision = decideSheetDivergence(snapshotInputHash, currentHash);
      if (decision.kind === 'divergent') {
        await saveDivergentCharacterSheet({
          scopedDb,
          characterId: characterDbId,
          sequenceId,
          model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
          url: storageResult.url,
          storagePath: storageResult.path,
          workflowRunId,
          snapshotInputHash: decision.snapshotInputHash,
        });
        return { kind: 'divergent' };
      }
      await scopedDb.characters.updateSheet(
        characterDbId,
        storageResult.url,
        storageResult.path,
        snapshotInputHash
      );
      return { kind: 'convergent' };
    }
  );

  if (reconcileOutcome.kind === 'divergent') {
    await step.do('settle-divergent-status', async () => {
      await scopedDb.characters.updateSheetStatus(characterDbId, 'completed');
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

    // Validate snapshot hash inside the workflow body. Matches QStash parity:
    // tampered payloads must halt the run from inside a step, not silently.
    await step.do('validate-snapshot', async () => {
      if (input.snapshotInputHash) {
        const expected = input.snapshotInputHash;
        const recomputed = await computeCharacterSheetHashFromDto(input);
        if (recomputed !== expected) {
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
      kind: 'character-sheet',
      logTag: '[CharacterSheetWorkflow:cf]',
      subject: `sheet for ${input.characterName}`,
      stepName: 'generate-sheet-image',
      params: builtParams,
      meta: { characterDbId: input.characterDbId },
    });
    const imageResult = generation.result;
    const generationParams = generation.params;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(
      step,
      scopedDb,
      imageResult.metadata
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Character sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        metadata: {
          ...falUsage,
          model: generationParams.model,
          characterName: input.characterName,
          characterDbId: input.characterDbId,
        },
        workflowName: 'CharacterSheetWorkflow',
      });
    });

    const initialSheetImageUrl = imageResult.imageUrls[0];
    if (!initialSheetImageUrl) {
      throw new Error('Character sheet generation did not return an image URL');
    }
    let sheetImageUrl: string = initialSheetImageUrl;
    let sheetImagePath: string | undefined = undefined;

    if (input.characterDbId && input.teamId && input.sequenceId) {
      // Capture narrowed values so inner async closures see `string`, not
      // `string | undefined`.
      const characterDbId = input.characterDbId;
      const sequenceId = input.sequenceId;

      // Step 3: Upload to R2 storage
      const storageResult = await step.do('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        logger.info(
          `[CharacterSheetWorkflow:cf] Uploading sheet to storage for ${input.characterName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: characters/{teamId}/{sequenceId}/{characterDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${input.teamId}/${input.sequenceId}/${input.characterDbId}/${uniqueId}.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.CHARACTERS,
          storagePath,
          {
            contentType: 'image/png',
          }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      });

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

      // Step 4: Divergence-aware database write. On convergent, update the
      // character's primary sheet. On divergent, preserve the artifact as a
      // variant row (the helper emits `stale:detected`) and skip the primary
      // update so the in-flight run does not overwrite a now-stale identity.
      const snapshotInputHash = input.snapshotInputHash ?? null;
      const reconcileOutcome = await step.do(
        'reconcile-database',
        async (): Promise<{ kind: 'convergent' } | { kind: 'divergent' }> => {
          logger.info(
            `[CharacterSheetWorkflow:cf] Updating database for ${input.characterName}`
          );

          const currentHash = snapshotInputHash
            ? await computeCharacterSheetHashCurrent(input, scopedDb.liveRead)
            : null;

          const decision = decideSheetDivergence(
            snapshotInputHash,
            currentHash
          );

          if (decision.kind === 'divergent') {
            logger.warn('[CharacterSheetWorkflow:cf] divergence detected', {
              characterDbId: input.characterDbId,
              snapshotInputHash: decision.snapshotInputHash,
              currentInputHash: decision.currentInputHash,
              storagePath: storageResult.path,
            });
            await saveDivergentCharacterSheet({
              scopedDb,
              characterId: characterDbId,
              sequenceId,
              model: generationParams.model,
              url: storageResult.url,
              storagePath: storageResult.path,
              workflowRunId,
              snapshotInputHash: decision.snapshotInputHash,
            });
            return { kind: 'divergent' };
          }

          await scopedDb.characters.updateSheet(
            input.characterDbId,
            storageResult.url,
            storageResult.path,
            snapshotInputHash
          );
          return { kind: 'convergent' };
        }
      );

      sheetImagePath = storageResult.path;
      sheetImageUrl = storageResult.url;

      if (reconcileOutcome.kind === 'divergent') {
        // Helper already emitted `stale:detected` on the sequence channel.
        // Settle the primary sheet's status so the UI does not stay wedged on
        // "Regenerating…". The pre-existing `sheetImageUrl` (if any) remains
        // the live primary identity — we deliberately did not overwrite it.
        // For first-time generation the entity ends in `completed` with a
        // null sheetImageUrl; the user can manually retry. Either way,
        // flipping status to `completed` reflects "generation finished,
        // primary unchanged, divergent variant saved alongside".
        await step.do('settle-divergent-status', async () => {
          await scopedDb.characters.updateSheetStatus(
            characterDbId,
            'completed'
          );
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

    // Mark character sheet as failed
    if (input.characterDbId) {
      await scopedDb.characters.updateSheetStatus(
        input.characterDbId,
        'failed',
        error
      );

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
