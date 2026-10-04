/**
 * The `locationBibleWorkflow` durable workflow.
 *
 * Mid-tier orchestrator: rather than generating each location reference image
 * inline, it fans out to child `LocationSheetWorkflow` instances via Pattern 3
 * (`spawnAndAwaitChild`).
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema';
import { buildLocationInsert } from './cast-records';
import { computeLocationSheetHashFromDto } from './sheet-snapshots';
import type { SheetPayload } from './sheet-snapshots';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  LibraryLocationMatch,
  LocationBibleWorkflowInput,
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/platform/logger';

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
        // Upsert on (sequenceId, locationId): the Script stage already
        // created these rows sheet-less, so this keeps their ids. The status
        // is NOT refreshed on conflict (a step replay must not clobber the
        // child's `completed`), so a placeholder reads `pending` until the
        // sheet child writes its terminal status.
        const locationInserts = input.locationBible.map((location) =>
          buildLocationInsert({
            sequenceId,
            location,
            libraryMatch: matchMap.get(location.locationId),
            referenceStatus: 'generating',
          })
        );

        const created = await scopedDb.sequenceLocations.createBulk(
          locationInserts,
          {
            source: 'analysis',
            createdBy: null,
          }
        );
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
    // What each row's upsert landed on: the bible version (#1600) and the
    // library link. The sheet claim is taken against both (#1863). A step
    // result cached before #1600 names no bible version; it is failed here,
    // once, rather than claimed unguarded further down.
    const snapshotByDbId = new Map<
      string,
      { bibleVersionId: string; libraryLocationId: string | null }
    >();
    for (const loc of createdLocations) {
      if (!loc.selectedBibleVersionId) {
        throw new WorkflowValidationError(
          'Queued before bible versions shipped. Run it again.'
        );
      }
      snapshotByDbId.set(loc.id, {
        bibleVersionId: loc.selectedBibleVersionId,
        libraryLocationId: loc.libraryLocationId,
      });
    }

    const childBinding = this.env.LOCATION_SHEET_WORKFLOW;

    const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Step 2: Spawn one LocationSheetWorkflow per location in parallel.
    // `Promise.all` for the spawn fan-out so a single spawn error fails fast;
    // `Promise.allSettled` for the await so one slow/failed sibling does not
    // hide outcomes for the others.
    const spawnAwaitPromises = input.locationBible.map(
      async (location, index) => {
        const locationDbId = locationIdToDbId.get(location.locationId);
        const snapshot = locationDbId && snapshotByDbId.get(locationDbId);
        if (!locationDbId || !snapshot) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] could not resolve dbId for location ${location.locationId}`
          );
        }

        const libraryMatch = matchMap.get(location.locationId);

        const unclaimedFields: SheetPayload<LocationSheetWorkflowInput> = {
          userId: input.userId,
          teamId,
          sequenceId,
          reservationId: input.reservationId,
          locationDbId,
          bibleVersionId: snapshot.bibleVersionId,
          locationName: location.name,
          locationMetadata: location,
          imageModel: model,
          referenceImageUrl: libraryMatch?.referenceImageUrl,
          libraryLocationDescription: libraryMatch?.description,
          styleConfig: input.styleConfig,
          libraryLocationReferenceHash:
            libraryMatch?.referenceInputHash ?? null,
        };
        // Tracked like any other sheet (#1113): hashed, and landed through a
        // claim a bible edit revokes. The claim is taken only while the bible
        // and library link the upsert returned are still live (#1863): an edit
        // that landed since had no claim to revoke, so the child parks.
        const unclaimed = {
          ...unclaimedFields,
          snapshotInputHash:
            await computeLocationSheetHashFromDto(unclaimedFields),
        };
        const referenceVersionId = await step.do(
          `claim-location-sheet-${index}`,
          async () => {
            const claim =
              await scopedDb.sequenceLocations.claimReferenceIfUnmoved(
                locationDbId,
                snapshot
              );
            if (!claim.held) {
              logger.warn(
                `[LocationBibleWorkflow:cf] Location ${locationDbId} moved before the claim; its sheet parks`
              );
            }
            return claim.versionId;
          }
        );
        const childPayload: LocationSheetWorkflowInput = {
          ...unclaimed,
          referenceVersionId,
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
            selectedReferenceVersionId: childResult.sheetVersionId ?? null,
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
          selectedReferenceVersionId: null,
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
    // Log only, no DB writes: the inserted `sequence_locations` rows stay in
    // `generating` and each child's own `onFailure` writes the per-row
    // failure. Log and let the base class rethrow.
    logger.error(
      `[LocationBibleWorkflow:cf] Location reference generation failed: ${error}`
    );
  }
}
