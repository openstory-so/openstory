import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { getSignedUploadUrl } from '#storage';
import { requireTeamAdminAccess } from '@/platform/server/auth/action-utils';
import { generateId } from '@/platform/id';
import {
  getPublicLibraryLocationById,
  listPublicLibraryLocations,
} from '@/platform/server/db/scoped';
import type { LibraryLocation } from '@/platform/server/db/schema';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { LibraryLocationSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeLibraryLocationSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import {
  createLibraryLocation,
  promoteLocationReferenceImages,
} from '@/cast/server/locations/create-library-location';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';

/**
 * Verify a location exists and belongs to the given team. Throws if not found.
 * Uses scopedDb which is already team-scoped via getById.
 */
async function requireLocation(
  scopedDb: {
    locations: { getById: (id: string) => Promise<LibraryLocation | null> };
  },
  locationId: string
) {
  const location = await scopedDb.locations.getById(locationId);
  if (!location) {
    throw new Error('Location not found');
  }
  return location;
}

export const getTeamLibraryLocationsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.locations.list();
  });

// List Public ("system") library locations — no auth, for anonymous visitors

export const getPublicLibraryLocationsFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  return listPublicLibraryLocations();
});

export const getLibraryLocationByIdFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ locationId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const location = await requireLocation(context.scopedDb, data.locationId);

    const sheets = await context.scopedDb.locationSheets.list(data.locationId);

    return {
      ...location,
      sequenceTitle: 'Library' as const,
      sheets,
    };
  });

// Get Single Public ("system") library location — no auth, for anonymous visitors

export const getPublicLibraryLocationByIdFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(z.object({ locationId: ulidSchema })))
  .handler(async ({ data }) => {
    const location = await getPublicLibraryLocationById(data.locationId);

    if (!location) {
      throw new Error('Location not found');
    }

    return location;
  });

export const createLibraryLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        referenceImageUrls: z.array(mediaUrlSchema).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { location: newLocation } = await createLibraryLocation(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
    });
    return { ...newLocation, sequenceTitle: 'Library' as const };
  });

export const updateLibraryLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        locationId: ulidSchema,
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        referenceImageUrl: mediaUrlSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await requireLocation(context.scopedDb, data.locationId);
    const { locationId, ...updateData } = data;
    return context.scopedDb.locations.update(locationId, updateData);
  });

export const deleteLibraryLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ locationId: ulidSchema })))
  .handler(async ({ context, data }) => {
    await requireLocation(context.scopedDb, data.locationId);
    await requireTeamAdminAccess(context.user.id, context.teamId);
    await context.scopedDb.locations.delete(data.locationId);
    return { success: true };
  });

export const presignLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        filename: z.string().min(1),
        locationId: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (data.locationId) {
      await requireLocation(context.scopedDb, data.locationId);
    }

    const ext = getExtensionFromUrl(data.filename);
    const uploadId = generateId();
    const contentType = getMimeTypeFromExtension(ext);

    // Every upload lands in `temp/` (#1581); finalize gates it and moves it.
    return getSignedUploadUrl(
      STORAGE_BUCKETS.LOCATIONS,
      `${context.teamId}/temp/${uploadId}.${ext}`,
      contentType
    );
  });

export const finalizeLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        locationId: ulidSchema,
        publicUrl: mediaUrlSchema,
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.publicUrl.startsWith(`/r2/locations/${context.teamId}/temp/`)) {
      throw new Error('Invalid storage path');
    }

    await requireLocation(context.scopedDb, data.locationId);

    const [promoted] = await promoteLocationReferenceImages(
      context.scopedDb,
      [data.publicUrl],
      context.teamId
    );
    if (!promoted) throw new Error('Invalid storage path');

    await context.scopedDb.locations.update(data.locationId, {
      referenceImageUrl: promoted.url,
      referenceImagePath: promoted.path,
    });

    return { success: true };
  });

export const addLocationSheetsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        locationId: ulidSchema,
        imageUrls: z.array(mediaUrlSchema).min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const location = await requireLocation(context.scopedDb, data.locationId);

    const processedImages = await promoteLocationReferenceImages(
      context.scopedDb,
      data.imageUrls,
      context.teamId
    );

    if (processedImages.length === 0) {
      return { sheets: [] };
    }

    const existingSheets = await context.scopedDb.locationSheets.list(
      data.locationId
    );

    const hasExistingSheets = existingSheets.length > 0;

    // If no sheets exist but location has a reference image, backfill it as a sheet
    if (!hasExistingSheets && location.referenceImageUrl) {
      await context.scopedDb.locationSheets.insert([
        {
          locationId: data.locationId,
          name: 'Reference 1',
          imageUrl: location.referenceImageUrl,
          imagePath: location.referenceImagePath,
          isDefault: true,
          source: 'manual_upload' as const,
        },
      ]);
    }

    const newSheets = await context.scopedDb.locationSheets.insert(
      processedImages.map((img, index) => ({
        locationId: data.locationId,
        name: `Reference ${existingSheets.length + index + 1}`,
        imageUrl: img.url,
        imagePath: img.path,
        isDefault:
          !hasExistingSheets && !location.referenceImageUrl && index === 0,
        source: 'manual_upload' as const,
      }))
    );

    // Collect all reference URLs for the sheet generation workflow
    let existingUrls: string[];
    if (hasExistingSheets) {
      existingUrls = existingSheets
        .map((s) => s.imageUrl)
        .filter((url): url is string => url !== null);
    } else if (location.referenceImageUrl) {
      existingUrls = [location.referenceImageUrl];
    } else {
      existingUrls = [];
    }

    const workflowInput: LibraryLocationSheetWorkflowInput = {
      locationDbId: data.locationId,
      locationName: location.name,
      locationDescription: location.description ?? undefined,
      referenceImageUrls: [
        ...existingUrls,
        ...processedImages.map((img) => img.url),
      ],
      userId: context.user.id,
      teamId: context.teamId,
      sequenceId: 'library',
    };
    workflowInput.snapshotInputHash =
      await computeLibraryLocationSheetHashFromDto(workflowInput);

    const workflowRunId = await triggerWorkflow(
      '/library-location-sheet',
      workflowInput
    );

    return { sheets: newSheets, workflowRunId };
  });

export const deleteLocationSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ sheetId: ulidSchema })))
  .handler(async ({ context, data }) => {
    const record = await context.scopedDb.locationSheets.getWithLocation(
      data.sheetId
    );
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!record || record.location.teamId !== context.teamId) {
      throw new Error('Sheet not found');
    }

    const { sheet, location } = record;

    await context.scopedDb.locationSheets.delete(data.sheetId);

    // If deleted sheet was default, promote the next available sheet
    if (sheet.isDefault) {
      await context.scopedDb.locationSheets.promoteDefault(location.id);
    }

    return { success: true };
  });
