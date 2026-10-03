import { isValidTextToImageModel } from '@/models/models';
import type { SheetStaleness } from '@/cast/server/sheets/sheet-staleness';
import { locationBibleFieldsSchema } from './bible-field';
import {
  createLocation,
  deleteLocation,
  restoreLocation,
  updateLocation,
} from '@/cast/server/cast-edit';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { readReferenceStaleness } from '@/cast/server/production-staleness';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  recastLocation,
  regenerateLocationSheet,
} from '@/cast/server/cast-generation';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.list(context.sequence.id);
  });

// ============================================================================
// Manual location CRUD (#1108 Phase 2)
// ============================================================================

/**
 * Create a location by hand (no storyboard run) — starts reference-less
 * (`referenceStatus: 'pending'`); the reference image comes later via the
 * existing recast / sheet workflows. `locationId` is a shortened name
 * (`loc_office`) like script-extracted `loc_001`, uniqued against existing
 * rows on the `(sequenceId, locationId)` index.
 */
export const createSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        name: z.string().trim().min(1).max(255),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, ...fields } = data;
    return await createLocation(
      context.scopedDb,
      { userId: context.user.id },
      sequenceId,
      fields
    );
  });

/**
 * Edit a location's bible fields. Only provided fields change; the location
 * sheet and the prompts that project them re-stale purely by hash derivation.
 * Library binding stays on `recastLocationFn`.
 */
export const updateSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationBibleFieldsSchema.extend({
        sequenceId: ulidSchema,
        locationDbId: ulidSchema,
        name: z.string().trim().min(1).max(255).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { sequenceId, locationDbId, ...fields } = data;
    return await updateLocation(
      context.scopedDb,
      { userId: context.user.id },
      sequenceId,
      locationDbId,
      fields
    );
  });

const locationIdInput = z.object({
  sequenceId: ulidSchema,
  locationDbId: ulidSchema,
});

/**
 * Soft-remove a location (undoable; toast Undo calls the restore fn). Scene
 * continuity tags are NOT stripped — undo is lossless.
 */
export const softDeleteSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(
    async ({ context, data }) =>
      await deleteLocation(
        context.scopedDb,
        { userId: context.user.id },
        data.sequenceId,
        data.locationDbId
      )
  );

/** Undo a location soft-delete. */
export const restoreSequenceLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(
    async ({ context, data }) =>
      await restoreLocation(
        context.scopedDb,
        { userId: context.user.id },
        data.sequenceId,
        data.locationDbId
      )
  );

export const getTeamLocationsLibraryFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.getTeamLibrary(context.teamId, {
      completedOnly: false,
    });
  });

const getShotIdsForLocationInputSchema = z.object({
  locationId: z.string().min(1),
});

export const getShotIdsForLocationFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(getShotIdsForLocationInputSchema))
  .handler(async ({ context, data }) => {
    const shotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        context.sequence.id,
        data.locationId
      );
    return { shotIds, count: shotIds.length };
  });

const recastLocationInputSchema = z.object({
  locationId: z.string().min(1),
  libraryLocationId: z.string().min(1),
});

export const regenerateLocationSheetFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      locationIdInput.extend({
        imageModel: z
          .string()
          .refine(isValidTextToImageModel, {
            message: 'Invalid image model',
          })
          .optional(),
      })
    )
  )
  .handler(({ context, data }) =>
    regenerateLocationSheet(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence,
      data
    )
  );

/** Live sheet staleness for the location detail banner. */
export const getLocationSheetStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationIdInput))
  .handler(
    async ({ context, data }): Promise<SheetStaleness> =>
      (
        await readReferenceStaleness(
          context.scopedDb,
          data.sequenceId,
          'location',
          data.locationDbId
        )
      ).status
  );

/**
 * Recast a location with a library location reference.
 * Triggers location reference regeneration and shot regeneration.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(recastLocationInputSchema))
  .handler(({ context, data }) =>
    recastLocation(context.scopedDb, { userId: context.user.id }, data)
  );
