/**
 * The team's locations (#1695): the Locations page list, one location with
 * the sequences that use it and its photos, its delete, and the writes made
 * with no sequence: create, bible and photos.
 */
import { getSignedUploadUrl } from '#storage';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { locationBibleFieldsSchema } from '@/cast/bible-field';
import {
  deleteTeamLocation,
  requireLocation,
  restoreTeamLocation,
  updateLocation,
} from '@/cast/server/cast-edit';
import {
  attachLocationReferenceImages,
  createTeamLocation,
} from '@/cast/server/locations/team-locations';
import { teamUserUploadStoragePath } from '@/cast/server/team-user-upload';
import { generateId } from '@/platform/id';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/platform/server/storage/file';

const locationIdSchema = z.object({ locationId: ulidSchema });
const nameSchema = z.string().trim().min(1).max(255);

export const listTeamLocationsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => await context.scopedDb.locations.listTeam());

/**
 * One location at its current version, with the sequences that use it and
 * the photos its sheet is drawn from.
 */
export const getTeamLocationFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(async ({ context, data }) => {
    const { locations } = context.scopedDb;
    const [location, team, photos] = await Promise.all([
      locations.getCurrent(data.locationId),
      locations.getTeamLocation(data.locationId),
      locations.listPhotos(data.locationId),
    ]);
    // Null, not an error: the page says "not found" for a location that is
    // gone or another team's.
    if (!location || !team) return null;
    return {
      ...location,
      lastUsedAt: team.lastUsedAt,
      usedAnywhere: team.usedAnywhere,
      sequences: team.sequences,
      photos,
    };
  });

/** Live divergent sheet alternates across the team's locations: the card dots. */
export const getTeamLocationDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const locations = await context.scopedDb.locations.listTeam();
    return await context.scopedDb.locationSheetVariants.listDivergentActiveByLocations(
      locations.map((location) => location.id)
    );
  });

/** Make a location with no sequence and start its sheet. */
export const createTeamLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
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
      await createTeamLocation(
        context.scopedDb,
        { ...data, description: data.description || null },
        { userId: context.user.id, teamId: context.teamId, triggerSheet: true }
      )
  );

/** Edit a location's bible from no sequence; every sequence reads the edit. */
export const updateTeamLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
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

/** Delete a location no sequence uses. Soft: `restoreTeamLocationFn` undoes it. */
export const deleteTeamLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(
    async ({ context, data }) =>
      await deleteTeamLocation(context.scopedDb, data.locationId)
  );

export const restoreTeamLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(locationIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreTeamLocation(context.scopedDb, data.locationId)
  );

/** A signed URL to upload one photo to; the photo is attached afterwards. */
export const presignLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ filename: z.string().min(1) })))
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);

    // Lands in `uploads/` and stays there (#1634). Attaching it gates on the
    // likeness ledger, then points a photo row at this key.
    return getSignedUploadUrl(
      STORAGE_BUCKETS.LOCATIONS,
      teamUserUploadStoragePath(context.teamId, generateId(), ext),
      getMimeTypeFromExtension(ext)
    );
  });

/**
 * Attach one uploaded photo to a location without drawing: the sheet reads
 * stale until it is regenerated.
 */
export const finalizeLocationUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(locationIdSchema.extend({ publicUrl: mediaUrlSchema }))
  )
  .handler(async ({ context, data }) => {
    await requireLocation(context.scopedDb, null, data.locationId);
    const photos = await attachLocationReferenceImages(
      context.scopedDb,
      [data.publicUrl],
      context.teamId
    );
    await context.scopedDb.locations.addPhotos(data.locationId, photos);
    return { success: true };
  });

/**
 * Remove one photo. The sheet is not redrawn: it reads stale, and a run in
 * flight loses its claim.
 */
export const removeTeamLocationPhotoFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(locationIdSchema.extend({ photoId: ulidSchema })))
  .handler(async ({ context, data }) => {
    await context.scopedDb.locations.removePhoto(data.locationId, data.photoId);
    return { success: true };
  });
