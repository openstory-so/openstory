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
import { landSheetRun } from './sheet-divergence';
import type { SheetRunOutcome } from './sheet-divergence';
import {
  characterSheetHashMatchesStored,
  queuedLegacyStyling,
  assertQueuedWithFace,
  assertQueuedWithRendering,
  assertQueuedWithLooks,
} from './sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';
import { castChannelId } from '@/cast/cast-channel';
import { drawSheetPortrait } from '@/cast/server/sheets/sheet-portrait';

const logger = getLogger(['openstory', 'workflow', 'character-sheet']);

/**
 * Land the sheet on its look (#2015) through the claim the trigger took
 * (#1113): select it only while the claim still names it, else park it as
 * divergent and tell the UI.
 * A run queued before #1113 carries no claim: it lands only while no newer run
 * holds one, and otherwise parks instead of revoking that run's claim.
 */
async function landSheet(
  scopedDb: WorkflowScopedDb,
  input: CharacterSheetWorkflowInput,
  stored: {
    url: string;
    path: string;
    model: string;
    portraitUrl: string | null;
  },
  workflowRunId: string
): Promise<SheetRunOutcome> {
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
  const claimed = Boolean(input.sheetVersionId);
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
  const versionId = input.sheetVersionId ?? generateId();
  return landSheetRun({
    land: () =>
      scopedDb.characterSheetVariants.promoteIfPending({
        characterId: input.characterDbId,
        lookId: input.lookId,
        lookVersionId: input.lookVersionId,
        versionId,
        claimed,
        url: stored.url,
        storagePath: stored.path,
        portraitUrl: stored.portraitUrl,
        inputHash: input.snapshotInputHash,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload queued before #1600
        bibleVersionId: input.bibleVersionId ?? null,
        model: stored.model,
        workflowRunId,
      }),
    logger,
    logTag: '[CharacterSheetWorkflow:cf]',
    channelId: castChannelId(input.sequenceId, input.characterDbId),
    entityType: 'character',
    entityId: input.characterDbId,
    versionId,
    claimed,
    storagePath: stored.path,
    snapshotInputHash: input.snapshotInputHash,
  });
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
  if (!input.characterDbId || !input.teamId) {
    throw new WorkflowValidationError(
      'reuseTalentSheet requires characterDbId and teamId'
    );
  }
  const characterDbId = input.characterDbId;
  const sequenceId = input.sequenceId;
  const channel = getGenerationChannel(
    castChannelId(sequenceId, characterDbId)
  );

  const storageResult = await step.do('copy-talent-sheet', async () => {
    logger.info(
      `[CharacterSheetWorkflow:cf] Reusing talent sheet for ${input.characterName}`
    );
    const uniqueId = generateId();
    const storagePath = `${input.teamId}/${sheetStorageScope(sequenceId)}/${characterDbId}/${uniqueId}.png`;
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
      sequenceId: sequenceId ?? undefined,
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
        // A reused talent sheet costs nothing, and is the four-across
        // layout the tile's crop was made for: no portrait is drawn.
        portraitUrl: null,
      },
      workflowRunId
    )
  );

  if (reconcileOutcome.kind === 'divergent') {
    await step.do('settle-divergent-status', async () => {
      await channel.emit('generation.character-sheet:progress', {
        characterId: characterDbId,
        lookId: input.lookId,
        status: 'completed',
      });
    });
    return {
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      characterDbId,
      lookId: input.lookId,
      diverged: true,
    };
  }

  await step.do('emit-complete-event', async () => {
    await channel.emit('generation.character-sheet:progress', {
      characterId: characterDbId,
      lookId: input.lookId,
      status: 'completed',
      sheetImageUrl: storageResult.url,
    });
  });

  return {
    sheetImageUrl: storageResult.url,
    sheetImagePath: storageResult.path,
    characterDbId,
    lookId: input.lookId,
    sheetVersionId: reconcileOutcome.versionId,
  };
}

/** Where a run's sheet is stored: under its sequence, or the team's own. */
const sheetStorageScope = (sequenceId: string | null) => sequenceId ?? 'team';

export class CharacterSheetWorkflow extends OpenStoryWorkflowEntrypoint<CharacterSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<CharacterSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;
    assertQueuedWithLooks(input);
    assertQueuedWithFace(input);
    assertQueuedWithRendering(input);

    // Validate the snapshot hash inside the workflow body: a tampered
    // payload must halt the run from inside a step, not silently.
    await step.do('validate-snapshot', async () => {
      // Accepts the pre-#1785 shape too, so a run queued before the
      // hash grew a channel does not read as tampered.
      if (
        !(await characterSheetHashMatchesStored(
          input.snapshotInputHash,
          input,
          queuedLegacyStyling(input),
          // Its own snapshot: the current shape, no sequence in view.
          null
        ))
      ) {
        throw new WorkflowValidationError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
        );
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      if (input.characterDbId) {
        await getGenerationChannel(
          castChannelId(input.sequenceId, input.characterDbId)
        ).emit('generation.character-sheet:progress', {
          characterId: input.characterDbId,
          lookId: input.lookId,
          status: 'generating',
        });
      }
    });

    // A look other than the default is drawn from that look's sheet. The
    // talent-sheet copy is only for the default look's first sheet.
    if (input.reuseTalentSheet && input.face === null) {
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

        // Build prompt with character identity + talent appearance + rendering
        const { prompt, referenceUrls } = buildCharacterSheetPrompt(
          input.characterMetadata,
          talentOverrides,
          input.lookStyling,
          input.face === null ? null : input.face.url
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
    // inside the generating step (#1645). A run from the Characters page has
    // no sequence (#2017): it stores under the team and reports on the
    // character's own channel.
    const characterDbId = input.characterDbId;
    const teamId = input.teamId;
    const sequenceId = input.sequenceId;
    const channel = getGenerationChannel(
      castChannelId(sequenceId, characterDbId)
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
      sequenceId: input.sequenceId ?? undefined,
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
          `${teamId}/${sheetStorageScope(sequenceId)}/${characterDbId}/${generateId()}.png`
        ),
      onRetry: async (retry) => {
        await channel.emit('generation.character-sheet:progress', {
          characterId: input.characterDbId,
          lookId: input.lookId,
          status: 'generating',
          phase: 'retrying',
          ...retry,
        });
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
        sequenceId: sequenceId ?? undefined,
        referenceImageCount: generationParams.referenceImageUrls?.length ?? 0,
      });
    });

    // The tile's portrait, drawn from the sheet just stored. It lands on the
    // same version row, so it can never show a sheet other than its own.
    const portraitUrl = await step.do('draw-portrait', () =>
      drawSheetPortrait({
        scopedDb,
        kind: 'character',
        sheetUrl: storageResult.url,
        storageDir: `${teamId}/${sheetStorageScope(sequenceId)}/${characterDbId}`,
        chargeKey: workflowRunId,
        userId: input.userId,
        sequenceId,
      })
    );

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
          portraitUrl,
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
        await channel.emit('generation.character-sheet:progress', {
          characterId: characterDbId,
          lookId: input.lookId,
          status: 'completed',
        });
      });
      logger.info(
        `[CharacterSheetWorkflow:cf] Diverged for ${input.characterName}; saved as variant`
      );
      return {
        sheetImageUrl,
        sheetImagePath,
        characterDbId: input.characterDbId,
        lookId: input.lookId,
        diverged: true,
      };
    }
    // Emit realtime event that generation is complete
    await step.do('emit-complete-event', async () => {
      if (input.characterDbId) {
        await channel.emit('generation.character-sheet:progress', {
          characterId: input.characterDbId,
          lookId: input.lookId,
          status: 'completed',
          sheetImageUrl,
        });
      }
    });

    const result: CharacterSheetWorkflowResult = {
      sheetImageUrl,
      sheetImagePath,
      characterDbId: input.characterDbId,
      lookId: input.lookId,
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

    // Mark the look's sheet as failed — through the claim, so a newer run's
    // claim and `generating` status survive this one's failure (#1113).
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: the run `assertQueuedWithLooks` just failed names no look
    if (!input.lookId) {
      // Its claim is found by the claim's own id, never by a guessed look.
      await scopedDb.characterLooks.failSheetClaimByVersion(
        input.sheetVersionId,
        error
      );
      return;
    }
    if (input.characterDbId) {
      await scopedDb.characterLooks.failSheetClaim(
        input.lookId,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        input.sheetVersionId ?? null,
        error
      );

      // Emit failure event for realtime UI update
      await getGenerationChannel(
        castChannelId(input.sequenceId, input.characterDbId)
      ).emit('generation.character-sheet:progress', {
        characterId: input.characterDbId,
        lookId: input.lookId,
        status: 'failed',
        error,
      });

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
