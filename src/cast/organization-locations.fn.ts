/**
 * The organization's locations (#1695): the Locations page list, one location with
 * the sequences that use it and its photos, its delete, and the writes made
 * with no sequence: create, bible and photos.
 */
import { getSignedUploadUrl } from '#storage';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { locationBibleFieldsSchema } from '@/cast/bible-field';
import {
  deleteOrganizationLocation,
  requireLocation,
  restoreOrganizationLocation,
  updateLocation,
} from '@/cast/server/cast-edit';
import {
  attachLocationReferenceImages,
  createOrganizationLocation,
} from '@/cast/server/locations/organization-locations';
import { organizationUserUploadStoragePath } from '@/cast/server/organization-user-upload';
import { generateId } from '@/platform/id';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';

const locationIdSchema = z.object({ locationId: ulidSchema });
const nameSchema = z.string().trim().min(1).max(255);

export const listOrganizationLocationsFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .handler(
    async ({ context }) => await context.scopedDb.locations.listOrganization()
  );

/**
 * One location at its current version, with the sequences that use it and
 * the photos its sheet is drawn from.
 */
export const getOrganizationLocationFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(async ({ context, data }) => {
    const { locations } = context.scopedDb;
    const [location, organization, photos] = await Promise.all([
      locations.getCurrent(data.locationId),
      locations.getOrganizationLocation(data.locationId),
      locations.listPhotos(data.locationId),
    ]);
    // Null, not an error: the page says "not found" for a location that is
    // gone or another organization's.
    if (!location || !organization) return null;
    return {
      ...location,
      lastUsedAt: organization.lastUsedAt,
      usedAnywhere: organization.usedAnywhere,
      sequences: organization.sequences,
      photos,
    };
  });

/** Live divergent sheet alternates across the organization's locations: the card dots. */
export const getOrganizationLocationDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithOrganizationMiddleware])
  .handler(async ({ context }) => {
    const locations = await context.scopedDb.locations.listOrganization();
    return await context.scopedDb.locationSheetVariants.listDivergentActiveByLocations(
      locations.map((location) => location.id)
    );
  });

/** Make a location with no sequence and start its sheet. */
export const createOrganizationLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      z.object({
        name: nameSchema,
        description: z.string().trim().max(2000).nullable(),
        // Required here: no sequence style to take it from.
        rendering: z.string().trim().min(1).max(2000),
        /** Uploaded photos (`presignLocationUploadFn`); `[]` draws from the text. */
        photoUrls: z.array(mediaUrlSchema),
      })
    )
  )
  .handler(
    async ({ context, data }) =>
      await createOrganizationLocation(
        context.scopedDb,
        { ...data, description: data.description || null },
        {
          userId: context.user.id,
          organizationId: context.organizationId,
          triggerSheet: true,
        }
      )
  );

/** Edit a location's bible from no sequence; every sequence reads the edit. */
export const updateOrganizationLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        locationId: ulidSchema,
        name: nameSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { locationId, ...fields } = data;
    return await updateLocation(
      context.scopedDb,
      { userId: context.user.id },
      null,
      locationId,
      fields
    );
  });

/** Delete a location no sequence uses. Soft: `restoreOrganizationLocationFn` undoes it. */
export const deleteOrganizationLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(
    async ({ context, data }) =>
      await deleteOrganizationLocation(context.scopedDb, data.locationId)
  );

export const restoreOrganizationLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreOrganizationLocation(context.scopedDb, data.locationId)
  );

/** A signed URL to upload one photo to; the photo is attached afterwards. */
export const presignLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.object({ filename: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);

    // Lands in `uploads/` and stays there (#1634). Attaching it gates on the
    // likeness ledger, then points a photo row at this key.
    return getSignedUploadUrl(
      STORAGE_BUCKETS.LOCATIONS,
      organizationUserUploadStoragePath(
        context.organizationId,
        generateId(),
        ext
      ),
      getMimeTypeFromExtension(ext)
    );
  });

/**
 * Attach one uploaded photo to a location without drawing: the sheet reads
 * stale until it is regenerated.
 */
export const finalizeLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(locationIdSchema.extend({ publicUrl: mediaUrlSchema }))
  )
  .handler(async ({ context, data }) => {
    await requireLocation(context.scopedDb, null, data.locationId);
    const photos = await attachLocationReferenceImages(
      context.scopedDb,
      [data.publicUrl],
      context.organizationId
    );
    await context.scopedDb.locations.addPhotos(data.locationId, photos);
    return { success: true };
  });

/**
 * Remove one photo. The sheet is not redrawn: it reads stale, and a run in
 * flight loses its claim.
 */
export const removeOrganizationLocationPhotoFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(locationIdSchema.extend({ photoId: ulidSchema })))
  .handler(async ({ context, data }) => {
    await context.scopedDb.locations.removePhoto(data.locationId, data.photoId);
    return { success: true };
  });
