/**
 * Cloudflare Workflows port of `locationBibleWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/location-bible-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * key differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Mid-tier orchestrator: instead of generating each location reference
 *     image inline, it fans out to child `LocationSheetWorkflow` instances
 *     via Pattern 3 (`spawnAndAwaitChild`). The QStash version did the
 *     equivalent work inline because `context.invoke()` returned the child's
 *     value directly; CF has no equivalent so we spawn-and-await. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type {
  NewSequenceLocation,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  LibraryLocationMatch,
  LocationBibleWorkflowInput,
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'location-bible']);

export class LocationBibleWorkflow extends OpenStoryWorkflowEntrypoint<LocationBibleWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<SequenceLocationMinimal[]> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { libraryLocationMatches = [] } = input;

    // Validation throws happen at the top of runImpl so the base class can
    // re-wrap them as CF `NonRetryableError`s (see `WorkflowValidationError`
    // handling in `base-workflow.ts`).
    if (!input.sequenceId) {
      throw new WorkflowValidationError(
        'sequenceId is required for location bible generation'
      );
    }
    if (!input.teamId) {
      throw new WorkflowValidationError(
        'teamId is required for location bible generation'
      );
    }

    const sequenceId = input.sequenceId;
    const teamId = input.teamId;

    // Create lookup map for library location matches
    const matchMap = new Map<string, LibraryLocationMatch>(
      libraryLocationMatches.map((m) => [m.locationId, m])
    );

    // Step 1: Insert locations into database
    const createdLocations = await step.do(
      'create-location-records',
      async () => {
        const locationInserts: NewSequenceLocation[] = input.locationBible.map(
          (location) => {
            // Check if there's a library match for this location
            const libraryMatch = matchMap.get(location.locationId);

            return {
              id: generateId(),
              sequenceId,
              locationId: location.locationId,
              name: location.name,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              type: location.type ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              timeOfDay: location.timeOfDay ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              description: location.description ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              architecturalStyle: location.architecturalStyle ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              keyFeatures: location.keyFeatures ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              colorPalette: location.colorPalette ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              lightingSetup: location.lightingSetup ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              ambiance: location.ambiance ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              consistencyTag: location.consistencyTag ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionSceneId: location.firstMention?.sceneId ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionText: location.firstMention?.text ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionLine: location.firstMention?.lineNumber ?? null,
              referenceStatus: 'generating' as const,
              // Link to library location if matched
              libraryLocationId: libraryMatch?.libraryLocationId ?? null,
            };
          }
        );

        const created =
          await scopedDb.sequenceLocations.createBulk(locationInserts);
        if (created.length !== input.locationBible.length) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] expected ${input.locationBible.length} location records, created ${created.length}`
          );
        }
        return created;
      }
    );

    // Create a mapping from locationId (from bible) to database id
    const locationIdToDbId = new Map<string, string>(
      createdLocations.map((loc) => [loc.locationId, loc.id])
    );

    const childBinding = this.env.LOCATION_SHEET_WORKFLOW;

    const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Step 2: Spawn one LocationSheetWorkflow per location in parallel.
    // `Promise.all` for the spawn fan-out so a single spawn error fails fast;
    // `Promise.allSettled` for the await so one slow/failed sibling does not
    // hide outcomes for the others.
    const spawnAwaitPromises = input.locationBible.map(
      async (location, index) => {
        const locationDbId = locationIdToDbId.get(location.locationId);
        if (!locationDbId) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] could not resolve dbId for location ${location.locationId}`
          );
        }

        const libraryMatch = matchMap.get(location.locationId);

        const childPayload: LocationSheetWorkflowInput = {
          userId: input.userId,
          teamId,
          sequenceId,
          reservationId: input.reservationId,
          locationDbId,
          locationName: location.name,
          locationMetadata: location,
          imageModel: model,
          referenceImageUrl: libraryMatch?.referenceImageUrl,
          libraryLocationDescription: libraryMatch?.description,
          styleConfig: input.styleConfig,
        };

        return await spawnAndAwaitChild<
          LocationSheetWorkflowInput,
          LocationSheetWorkflowResult
        >(step, {
          binding: childBinding,
          parentBindingName: 'LOCATION_BIBLE_WORKFLOW',
          parentInstanceId,
          childId: `location-sheet:${locationDbId}`,
          childPayload,
          spawnStepName: `spawn-location-sheet-${index}`,
          awaitStepName: `await-location-sheet-${index}`,
          timeout: '30 minutes',
        });
      }
    );

    const settled = await Promise.allSettled(spawnAwaitPromises);

    // Re-assemble the SequenceLocationMinimal[] result in input order. For any
    // child that failed, fall back to the inserted DB row (the child workflow's
    // `onFailure` already marked the row `failed` and emitted the realtime
    // event, so the UI is up to date — we just need a non-throwing return so
    // the rest of the bible succeeds).
    const seqLocations: SequenceLocationMinimal[] = input.locationBible.map(
      (location, index) => {
        // Promise.allSettled returns one entry per input promise, so `outcome`
        // is always defined for `index < input.locationBible.length`.
        const outcome = settled[index];
        const dbId = locationIdToDbId.get(location.locationId);

        if (outcome?.status === 'fulfilled') {
          const childResult = outcome.value;
          return {
            id: dbId ?? childResult.locationDbId ?? generateId(),
            locationId: location.locationId,
            name: location.name,
            referenceImageUrl: childResult.referenceImageUrl,
            referenceStatus: 'completed' as const,
            referenceInputHash: null,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            description: location.description ?? null,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            consistencyTag: location.consistencyTag ?? null,
          };
        }

        const rejectionReason = outcome?.reason;
        const reason =
          rejectionReason instanceof Error
            ? rejectionReason.message
            : rejectionReason !== undefined
              ? String(rejectionReason)
              : 'unknown';
        logger.warn(
          `[LocationBibleWorkflow:cf] Child location-sheet for ${location.locationId} did not complete: ${reason}`
        );

        return {
          id: dbId ?? generateId(),
          locationId: location.locationId,
          name: location.name,
          referenceImageUrl: null,
          referenceStatus: 'failed' as const,
          referenceInputHash: null,
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          description: location.description ?? null,
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          consistencyTag: location.consistencyTag ?? null,
        };
      }
    );

    logger.info(
      `[LocationBibleWorkflow:cf] Location bible completed for sequence ${sequenceId}: ${seqLocations.length} locations processed`
    );

    return seqLocations;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<LocationBibleWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    // QStash's `failureFunction` here just logged + returned a friendly
    // message — no DB writes (the inserted `sequence_locations` rows stay in
    // `generating` and each child's own `onFailure` writes per-row failure).
    // Mirror that behaviour exactly: log and let the base class rethrow.
    logger.error(
      `[LocationBibleWorkflow:cf] Location reference generation failed: ${error}`
    );
  }
}
