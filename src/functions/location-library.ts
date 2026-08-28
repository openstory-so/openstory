import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { getSignedUploadUrl } from '#storage';
import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { generateId } from '@/lib/db/id';
import {
  getPublicLibraryLocationById,
  listPublicLibraryLocations,
} from '@/lib/db/scoped';
import type { LibraryLocation } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryLocationSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryLocationSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import {
  createLibraryLocation,
  promoteLocationReferenceImages,
} from '@/lib/locations/create-library-location';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

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
    const newLocation = await createLibraryLocation(data, {
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

    const storagePath = data.locationId
      ? `${context.teamId}/library/${uploadId}.${ext}`
      : `${context.teamId}/temp/${uploadId}.${ext}`;

    return getSignedUploadUrl(
      STORAGE_BUCKETS.LOCATIONS,
      storagePath,
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
        path: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.path.startsWith(`locations/${context.teamId}/`)) {
      throw new Error('Invalid storage path');
    }

    await requireLocation(context.scopedDb, data.locationId);

    await context.scopedDb.locations.update(data.locationId, {
      referenceImageUrl: data.publicUrl,
      referenceImagePath: data.path,
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
      workflowInput,
      { label: buildWorkflowLabel(data.locationId) }
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
