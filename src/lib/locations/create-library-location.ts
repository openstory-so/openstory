/**
 * Shared core for creating a library location: promotes reference images
 * temp→permanent, inserts the row + location sheets, and triggers the
 * `/library-location-sheet` workflow (which sets `location.referenceImageUrl`).
 * Used by `createLibraryLocationFn` (dashboard) and the public API's one-shot
 * resolver, so an on-the-fly location gets a reference generated — and the
 * storyboard workflow's `waitForLocationReferences` gate waits for it.
 */

import { moveFile } from '#storage';
import { generateId } from '@/lib/db/id';
import type { LibraryLocation } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryLocationSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryLocationSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';

const logger = getLogger(['openstory', 'locations', 'create-library-location']);

export type ProcessedImage = { url: string; path: string };

/**
 * Move temp-uploaded location images to permanent storage, returning only
 * successfully moved images. Shared with `addLocationSheetsFn`.
 */
export async function promoteLocationReferenceImages(
  tempUrls: string[],
  teamId: string
): Promise<ProcessedImage[]> {
  const results: ProcessedImage[] = [];

  for (const tempUrl of tempUrls) {
    const tempPathMatch = tempUrl.match(/\/locations\/(.+)$/);
    const tempPath = tempPathMatch?.[1];
    if (!tempPath) continue;

    const ext = getExtensionFromUrl(tempUrl);
    const permanentPath = `${teamId}/library/${generateId()}.${ext}`;

    await moveFile(STORAGE_BUCKETS.LOCATIONS, tempPath, permanentPath);
    const url = getPublicUrl(STORAGE_BUCKETS.LOCATIONS, permanentPath);
    results.push({ url, path: permanentPath });
  }

  return results;
}

export type CreateLibraryLocationInput = {
  name: string;
  description?: string;
  /** Temp-upload URLs in the LOCATIONS bucket; moved to permanent here. */
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
  sheetWorkflowInput: LibraryLocationSheetWorkflowInput;
};

export async function enqueueLibraryLocationSheet(
  workflowInput: LibraryLocationSheetWorkflowInput,
  locationId: string
): Promise<void> {
  try {
    await triggerWorkflow('/library-location-sheet', workflowInput, {
      label: buildWorkflowLabel(locationId),
    });
  } catch (error) {
    logger.error('Failed to trigger location sheet workflow:', { err: error });
  }
}

export async function createLibraryLocation(
  input: CreateLibraryLocationInput,
  ctx: CreateLibraryLocationContext,
  options?: CreateLibraryLocationOptions
): Promise<CreateLibraryLocationResult> {
  const processedImages = await promoteLocationReferenceImages(
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
  const workflowInput: LibraryLocationSheetWorkflowInput = {
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
    void enqueueLibraryLocationSheet(workflowInput, newLocation.id);
  }

  return { location: newLocation, sheetWorkflowInput: workflowInput };
}
