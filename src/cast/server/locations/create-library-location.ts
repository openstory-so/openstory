/**
 * Shared core for creating a library location: points reference images at
 * the already-uploaded `uploads/` keys (#1634), inserts the row + location
 * sheets, and triggers the `/library-location-sheet` workflow (which sets
 * `location.referenceImageUrl`). Used by `createLibraryLocationFn`
 * (dashboard) and the public API's one-shot resolver, so an on-the-fly
 * location gets a reference generated — and the storyboard workflow's
 * `waitForLocationReferences` gate waits for it.
 */

import { requireUploadRights } from '@/cast/server/upload-rights';
import { assertTeamUserUploadAttachable } from '@/cast/server/team-user-upload';
import type { LibraryLocation } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { LibraryLocationSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeLibraryLocationSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import type { SheetPayload } from '@/cast/server/workflows/sheet-snapshots';

const logger = getLogger(['openstory', 'locations', 'create-library-location']);

export type ProcessedImage = { url: string; path: string };

/**
 * Accept already-uploaded location images. Every library write goes through
 * here, so this is where the likeness gate runs (#1581): each still must be
 * cleared or signed. The object stays at its `uploads/` key (#1634).
 */
export async function attachLocationReferenceImages(
  scopedDb: ScopedDb,
  uploadUrls: string[],
  teamId: string
): Promise<ProcessedImage[]> {
  await requireUploadRights(scopedDb, uploadUrls);
  const results: ProcessedImage[] = [];

  for (const url of uploadUrls) {
    results.push(
      await assertTeamUserUploadAttachable({
        url,
        bucket: STORAGE_BUCKETS.LOCATIONS,
        teamId,
      })
    );
  }

  return results;
}

export type CreateLibraryLocationInput = {
  name: string;
  description?: string;
  /** User-upload URLs in the LOCATIONS bucket (`uploads/`); not moved. */
  referenceImageUrls?: string[];
};

export type CreateLibraryLocationContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
};

export type CreateLibraryLocationOptions = {
  /**
   * When false, insert the location but do not trigger the billed sheet
   * workflow. The caller enqueues {@link CreateLibraryLocationResult.sheetWorkflowInput}
   * after the sequence exists.
   * @default true
   */
  enqueueSheet?: boolean;
};

export type CreateLibraryLocationResult = {
  location: LibraryLocation;
  sheetWorkflowInput: SheetPayload<LibraryLocationSheetWorkflowInput>;
};

/**
 * Take the reference claim (#1113) and start the library sheet run. A run
 * whose claim an edit revokes before it publishes parks its preview instead.
 */
export async function triggerLibraryLocationSheet(
  scopedDb: Pick<ScopedDb, 'locations'>,
  workflowInput: SheetPayload<LibraryLocationSheetWorkflowInput>
): Promise<string> {
  const referenceClaimId = await scopedDb.locations.claimReference(
    workflowInput.locationDbId
  );
  try {
    return await triggerWorkflow('/library-location-sheet', {
      ...workflowInput,
      referenceClaimId,
    });
  } catch (error) {
    await scopedDb.locations.clearReferenceClaimIf(
      workflowInput.locationDbId,
      referenceClaimId
    );
    throw error;
  }
}

/** {@link triggerLibraryLocationSheet}, logging instead of throwing. */
export async function enqueueLibraryLocationSheet(
  scopedDb: Pick<ScopedDb, 'locations'>,
  workflowInput: SheetPayload<LibraryLocationSheetWorkflowInput>
): Promise<void> {
  try {
    await triggerLibraryLocationSheet(scopedDb, workflowInput);
  } catch (error) {
    logger.error('Failed to trigger location sheet workflow:', { err: error });
  }
}

export async function createLibraryLocation(
  input: CreateLibraryLocationInput,
  ctx: CreateLibraryLocationContext,
  options?: CreateLibraryLocationOptions
): Promise<CreateLibraryLocationResult> {
  const processedImages = await attachLocationReferenceImages(
    ctx.scopedDb,
    input.referenceImageUrls ?? [],
    ctx.teamId
  );

  const mainImage = processedImages[0];

  const newLocation = await ctx.scopedDb.locations.create({
    name: input.name,
    description: input.description,
    referenceImageUrl: mainImage?.url,
    referenceImagePath: mainImage?.path,
  });

  if (processedImages.length > 0) {
    await ctx.scopedDb.locationSheets.insert(
      processedImages.map((img, index) => ({
        locationId: newLocation.id,
        name: `Reference ${index + 1}`,
        imageUrl: img.url,
        imagePath: img.path,
        isDefault: index === 0,
        source: 'manual_upload' as const,
      }))
    );
  }

  // Sheet generation works with or without reference images. The public API
  // defers the trigger until the sequence exists (`enqueueSheet: false`).
  const workflowInput: SheetPayload<LibraryLocationSheetWorkflowInput> = {
    locationDbId: newLocation.id,
    locationName: input.name,
    locationDescription: input.description,
    referenceImageUrls: processedImages.map((img) => img.url),
    userId: ctx.user.id,
    teamId: ctx.teamId,
    sequenceId: 'library',
  };
  workflowInput.snapshotInputHash =
    await computeLibraryLocationSheetHashFromDto(workflowInput);

  if (options?.enqueueSheet !== false) {
    // Dashboard create: fire-and-forget so the dialog can return immediately.
    void enqueueLibraryLocationSheet(ctx.scopedDb, workflowInput);
  }

  return { location: newLocation, sheetWorkflowInput: workflowInput };
}
