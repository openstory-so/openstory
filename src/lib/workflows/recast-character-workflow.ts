/**
 * Recast a character onto new talent: regenerate its sheet, then regenerate
 * every shot the character appears in against that new sheet.
 *
 * Both children are spawned with `spawnAndAwaitChild` (Pattern 3). The
 * workflow reads nothing: the sheet DTO and the per-shot regenerate snapshots
 * are resolved in `recastCharacterFn` and inlined on the payload. The one
 * input that genuinely postdates the trigger — the sheet the child just
 * generated — is merged into the snapshots in memory (`recast-snapshot.ts`).
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/types';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  RecastCharacterWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import { computeRegenerateShotsBatchHash } from '@/lib/workflows/regenerate-shots-snapshot';
import { mergeRecastSheetIntoSnapshots } from '@/lib/workflows/recast-snapshot';
import { computeCharacterSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-character']);

type RecastCharacterWorkflowResult = {
  sheetImageUrl: string;
  shotsRegenerated: number;
  shotsFailed: number;
  /**
   * The sheet child preserved the character's existing primary sheet and
   * parked its output as a divergent variant, so no shot was regenerated —
   * regenerating here would render every shot against the OLD sheet.
   */
  sheetDiverged: boolean;
};

/** Mirrors `RegenerateShotsWorkflow`'s return type (module-local there). */
type RegenerateShotsChildResult = {
  totalShots: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
};

/**
 * Substitute the freshly generated sheet into the trigger-time snapshots and
 * hand them to the regenerate-shots child. Pure — the snapshots arrived on the
 * payload and the sheet arrived in memory from the awaited child.
 */
async function buildRegeneratePayload(
  input: RecastCharacterWorkflowInput,
  sheet: { imageUrl: string; inputHash: string | null }
): Promise<RegenerateShotsWorkflowInput> {
  const sequenceId = input.sequenceId;
  if (!sequenceId) {
    throw new NonRetryableError(
      '[RecastCharacterWorkflow:cf] sequenceId is required to regenerate shots',
      'WorkflowValidationError'
    );
  }
  const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = input.aspectRatio;

  const asSent = await computeRegenerateShotsBatchHash({
    sequenceId,
    imageModel,
    aspectRatio,
    shotSnapshots: input.shotSnapshots,
  });
  if (asSent !== input.snapshotInputHash) {
    throw new NonRetryableError(
      '[RecastCharacterWorkflow:cf] snapshotInputHash does not match the inlined shot snapshots',
      'WorkflowValidationError'
    );
  }

  const merged = await mergeRecastSheetIntoSnapshots({
    shotSnapshots: input.shotSnapshots,
    sequenceId,
    imageModel,
    aspectRatio,
    sheetImageUrl: sheet.imageUrl,
    sheetInputHash: sheet.inputHash,
  });

  return {
    userId: input.userId,
    teamId: input.teamId,
    sequenceId,
    shotIds: merged.shotSnapshots.map((s) => s.shotId),
    triggerKind: 'character' as const,
    triggerId: input.characterDbId,
    imageModel,
    aspectRatio,
    shotSnapshots: merged.shotSnapshots,
    snapshotInputHash: merged.snapshotInputHash,
  };
}

async function regenerateShots(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  input: RecastCharacterWorkflowInput,
  sheet: { imageUrl: string; inputHash: string | null }
): Promise<{ shotsRegenerated: number; shotsFailed: number }> {
  if (input.shotSnapshots.length === 0) {
    return { shotsRegenerated: 0, shotsFailed: 0 };
  }

  const result = await spawnAndAwaitChild<
    RegenerateShotsWorkflowInput,
    RegenerateShotsChildResult
  >(step, {
    binding: env.REGENERATE_SHOTS_WORKFLOW,
    parentBindingName: 'RECAST_CHARACTER_WORKFLOW',
    parentInstanceId,
    childId: `regenerate-shots:character:${input.characterDbId}`,
    childPayload: await step.do('snapshot-payload-for-regenerate', () =>
      buildRegeneratePayload(input, sheet)
    ),
    spawnStepName: 'spawn-regenerate-shots',
    awaitStepName: 'await-regenerate-shots',
  });

  return {
    shotsRegenerated: result.successCount,
    shotsFailed: result.failedShots.length,
  };
}

export class RecastCharacterWorkflow extends OpenStoryWorkflowEntrypoint<RecastCharacterWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastCharacterWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<RecastCharacterWorkflowResult> {
    const input = event.payload;

    // Step 1: Build the character-sheet payload. Captured into a const so the
    // spawn below reuses the cached step result on replay instead of
    // recomputing — and so the merge below can reuse the hash the child
    // stamped on the sheet row it wrote.
    const sheetPayload = await step.do(
      'build-character-sheet-snapshot',
      async (): Promise<CharacterSheetWorkflowInput> => {
        logger.info(
          `[RecastCharacterWorkflow:cf] Starting recast for ${input.characterName} with ${input.shotSnapshots.length} affected shots`
        );
        const partial: CharacterSheetWorkflowInput = {
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
          reuseTalentSheet: input.reuseTalentSheet,
          styleConfig: input.styleConfig,
          talentSheetInputHash: input.talentSheetInputHash,
        };
        partial.snapshotInputHash =
          await computeCharacterSheetHashFromDto(partial);
        return partial;
      }
    );

    const sheetResult = await spawnAndAwaitChild<
      CharacterSheetWorkflowInput,
      CharacterSheetWorkflowResult
    >(step, {
      binding: this.env.CHARACTER_SHEET_WORKFLOW,
      parentBindingName: 'RECAST_CHARACTER_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `character-sheet:recast:${input.characterDbId}`,
      childPayload: sheetPayload,
      spawnStepName: 'spawn-character-sheet',
      awaitStepName: 'await-character-sheet',
    });

    const sheetImageUrl = sheetResult.sheetImageUrl;

    if (sheetResult.diverged) {
      logger.warn(
        `[RecastCharacterWorkflow:cf] Sheet diverged for ${input.characterName}; skipping shot regeneration against the unchanged sheet`
      );
      return {
        sheetImageUrl,
        shotsRegenerated: 0,
        shotsFailed: 0,
        sheetDiverged: true,
      };
    }

    const { shotsRegenerated, shotsFailed } = await regenerateShots(
      step,
      this.env,
      event.instanceId,
      input,
      {
        imageUrl: sheetImageUrl,
        inputHash: sheetPayload.snapshotInputHash ?? null,
      }
    );

    return {
      sheetImageUrl,
      shotsRegenerated,
      shotsFailed,
      sheetDiverged: false,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RecastCharacterWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    await getGenerationChannel(input.sequenceId).emit(
      'generation.recast:failed',
      {
        characterId: input.characterDbId,
        error,
      }
    );

    logger.error(
      `[RecastCharacterWorkflow:cf] Recast failed for ${input.characterName}: ${error}`
    );
  }
}
