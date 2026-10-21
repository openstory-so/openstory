/**
 * The `locationBibleWorkflow` durable workflow.
 *
 * Mid-tier orchestrator: rather than generating each location reference image
 * inline, it fans out to child `LocationSheetWorkflow` instances via Pattern 3
 * (`spawnAndAwaitChild`). A script location matching bound to one of the
 * team's is linked to it and gets no sheet run (#1695). A location analysis
 * held (`createBulk`'s `held`: attached here, or used by another sequence)
 * keeps the sheet it already has.
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { sheetStartedSummary } from '@/sequences/model-label';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema';
import { toLocationMetadata } from '@/cast/server/sheets/location-sheet-trigger';
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
  protected override readonly failureLabel = 'Location design';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<SequenceLocationMinimal[]> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;

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

    // Create lookup map for the script locations matching bound (#1695)
    const matchMap = new Map<string, LibraryLocationMatch>(
      input.libraryLocationMatches.map((m) => [m.locationId, m])
    );

    // Step 1: Insert locations into database
    const createdLocations = await step.do(
      'create-location-records',
      async () => {
        // Upsert on the sequence's script ids: the Script stage already
        // created these rows sheet-less, so this keeps their ids. An entry
        // matching bound to a team location is linked to it, not created.
        // The status is NOT refreshed on conflict (a step replay must not
        // clobber the child's `completed`), so a placeholder reads `pending`
        // until the sheet child writes its terminal status.
        const locationInserts = input.locationBible.map((location) =>
          buildLocationInsert({
            sequenceId,
            location,
            libraryMatch: matchMap.get(location.locationId),
            referenceStatus: 'generating',
          })
        );

        const created = await scopedDb.locations.createBulk(locationInserts, {
          source: 'analysis',
          createdBy: null,
        });
        if (created.length !== input.locationBible.length) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] expected ${input.locationBible.length} location records, created ${created.length}`
          );
        }
        return created;
      }
    );

    // `createBulk` returns one row per entry, in order.
    const rowByScriptId = new Map(
      input.locationBible.map((location, index) => {
        const row = createdLocations[index];
        if (!row) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] could not resolve dbId for location ${location.locationId}`
          );
        }
        return [location.locationId, row] as const;
      })
    );

    // A step result cached before #1600 names no bible version; the run is
    // failed here, once. Inside the fan-out below the throw would be settled
    // into one failed sheet and the run would pass.
    for (const [scriptId, row] of rowByScriptId) {
      if (
        !matchMap.has(scriptId) &&
        !row.attached &&
        !row.selectedBibleVersionId
      ) {
        throw new WorkflowValidationError(
          'Queued before bible versions shipped. Run it again.'
        );
      }
    }

    const childBinding = this.env.LOCATION_SHEET_WORKFLOW;

    const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Step 2: Spawn one LocationSheetWorkflow per location this run made, in
    // parallel. A location the sequence only links to (matching bound it, the
    // writer attached it, or another sequence has used it) is the team's as
    // it is: no sheet is drawn. `held` is the upsert's decision, taken in
    // that step, so this fan-out does not ask again.
    // `Promise.all` for the spawn fan-out so a single spawn error fails fast;
    // `Promise.allSettled` for the await so one slow/failed sibling does not
    // hide outcomes for the others.
    const spawnAwaitPromises = input.locationBible.map(
      async (location, index): Promise<LocationSheetWorkflowResult | null> => {
        const row = rowByScriptId.get(location.locationId);
        if (!row) {
          throw new NonRetryableError(
            `[LocationBibleWorkflow:cf] could not resolve dbId for location ${location.locationId}`
          );
        }
        if (matchMap.has(location.locationId) || row.attached || row.held)
          return null;
        // Checked before the fan-out; this narrows the type.
        if (!row.selectedBibleVersionId) {
          throw new WorkflowValidationError(
            'Queued before bible versions shipped. Run it again.'
          );
        }
        const locationDbId = row.id;
        const bibleVersionId = row.selectedBibleVersionId;
        // Set once the claim step returns, so a spawn that never starts can
        // clear that claim. Null means the claim step itself did not finish.
        let claimed: { versionId: string; held: boolean } | null = null;

        try {
          const unclaimedFields: SheetPayload<LocationSheetWorkflowInput> = {
            userId: input.userId,
            teamId,
            sequenceId,
            reservationId: input.reservationId,
            locationDbId,
            bibleVersionId,
            locationName: row.name,
            // The bible the row holds, which is the version the claim guards:
            // analysis does not rewrite a location another sequence has used.
            locationMetadata: toLocationMetadata(row),
            imageModel: model,
            // ponytail: photos are not snapshotted (this workflow has no
            // trigger). A location with photos reads stale after this run;
            // snapshot them on the payload when a trigger is added.
            referencePhotoUrls: [],
          };
          // Tracked like any other sheet (#1113): hashed, and landed through a
          // claim a bible edit revokes. The claim is taken only while the bible
          // version the upsert returned is still live (#1863): an edit that
          // landed since had no claim to revoke, so the child parks.
          const unclaimed = {
            ...unclaimedFields,
            snapshotInputHash:
              await computeLocationSheetHashFromDto(unclaimedFields),
          };
          claimed = await step.do(`claim-location-sheet-${index}`, async () => {
            const claim = await scopedDb.locations.claimReferenceIfUnmoved(
              locationDbId,
              { bibleVersionId },
              {
                sequenceId,
                actorId: input.userId,
                summary: sheetStartedSummary(row.name, model),
              }
            );
            if (!claim.held) {
              logger.warn(
                `[LocationBibleWorkflow:cf] Location ${locationDbId} moved before the claim; its sheet parks`
              );
            }
            return claim;
          });
          const childPayload: LocationSheetWorkflowInput = {
            ...unclaimed,
            referenceVersionId: claimed.versionId,
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
        } catch (error) {
          // The child's onFailure does not run when the spawn never starts,
          // or the await times out while the child is still queued.
          // createBulk already left the row `generating`, and a taken claim
          // keeps the generation plan waiting.
          if (claimed === null || claimed.held) {
            const reason =
              error instanceof Error ? error.message : String(error);
            await scopedDb.locations.failReferenceClaim(
              locationDbId,
              claimed?.versionId ?? null,
              reason
            );
          }
          throw error;
        }
      }
    );

    const settled = await Promise.allSettled(spawnAwaitPromises);

    // Re-assemble the SequenceLocationMinimal[] result in input order. A failed
    // child falls back to the inserted row. The row is already `failed`: the
    // child's `onFailure` when the child started, or `failReferenceClaim` in
    // the catch above when the spawn never started. Either path has emitted
    // the realtime event, so this return only lets the rest of the bible finish.
    const seqLocations: SequenceLocationMinimal[] = input.locationBible.map(
      (location, index) => {
        // Promise.allSettled returns one entry per input promise, so `outcome`
        // is always defined for `index < input.locationBible.length`.
        const outcome = settled[index];
        const row = rowByScriptId.get(location.locationId);
        const base = {
          id: row?.id ?? generateId(),
          locationId: location.locationId,
          name: row?.name ?? location.name,
          referenceInputHash: null,
          description: row?.description ?? null,
          consistencyTag: row?.consistencyTag ?? null,
        };

        if (outcome?.status === 'fulfilled') {
          const childResult = outcome.value;
          // Linked, not drawn: the team location's sheet as it is.
          if (childResult === null) {
            return {
              ...base,
              referenceImageUrl: row?.referenceImageUrl ?? null,
              referenceStatus: row?.referenceStatus ?? 'pending',
              referenceInputHash: row?.referenceInputHash ?? null,
              selectedReferenceVersionId:
                row?.selectedReferenceVersionId ?? null,
            };
          }
          return {
            ...base,
            referenceImageUrl: childResult.referenceImageUrl,
            referenceStatus: 'completed' as const,
            selectedReferenceVersionId: childResult.sheetVersionId ?? null,
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
          ...base,
          referenceImageUrl: null,
          referenceStatus: 'failed' as const,
          selectedReferenceVersionId: null,
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
    // Log only, no DB writes: the inserted location rows stay in
    // `generating` and each child's own `onFailure` writes the per-row
    // failure. Log and let the base class rethrow.
    logger.error(
      `[LocationBibleWorkflow:cf] Location reference generation failed: ${error}`
    );
  }
}
