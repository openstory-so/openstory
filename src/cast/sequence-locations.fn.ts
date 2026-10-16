import { isValidTextToImageModel } from '@/models/models';
import type { SheetStaleness } from '@/cast/server/sheets/sheet-staleness';
import { locationBibleFieldsSchema } from './bible-field';
import {
  attachLocation,
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
  castAccessMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.locations.list(context.sequence.id);
  });

// ============================================================================
// Manual location CRUD (#1108 Phase 2)
// ============================================================================

/**
 * Create a location by hand (no storyboard run) — starts reference-less
 * (`referenceStatus: 'pending'`); the sheet comes later from Generate. It
 * is the team's from the start. `locationId` is a shortened name
 * (`loc_office`) like script-extracted `loc_001`, uniqued among the
 * sequence's script ids. `rendering` left out takes the sequence style's.
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
 * sheet and the prompts that project them re-stale purely by hash derivation,
 * in every sequence that uses the location.
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
 * Soft-remove a location from the sequence (undoable; toast Undo calls the
 * restore fn). Scene continuity tags are NOT stripped — undo is lossless. The
 * location stays the team's.
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

/**
 * Use one of the team's locations in this sequence (#1695): one link, nothing
 * copied, no generation started. Idempotent for a location the sequence
 * already uses; refused while a live location here has the same name.
 */
export const attachLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(z.object({ sequenceId: ulidSchema, locationId: ulidSchema }))
  )
  .handler(
    async ({ context, data }) =>
      await attachLocation(
        context.scopedDb,
        { userId: context.user.id },
        data.sequenceId,
        data.locationId
      )
  );

const getShotIdsForLocationInputSchema = z.object({
  locationId: z.string().min(1),
});

export const getShotIdsForLocationFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(getShotIdsForLocationInputSchema))
  .handler(async ({ context, data }) => {
    const shotIds = await context.scopedDb.locations.getShotIdsForLocation(
      context.sequence.id,
      data.locationId
    );
    return { shotIds, count: shotIds.length };
  });

// `sequenceId` null is the Locations page (#1695): the location is the
// team's, so its sheet is read and drawn the same from no sequence.
const castLocationInput = z.object({
  sequenceId: ulidSchema.nullable(),
  locationDbId: ulidSchema,
});

/**
 * One location as the sequence uses it or, from no sequence, at its current
 * version. Null, not an error, when it is gone or another team's.
 */
export const getLocationFn = createServerFn({ method: 'GET' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(castLocationInput))
  .handler(
    async ({ context, data }) =>
      await context.scopedDb.locations.get(
        context.sequence?.id ?? null,
        data.locationDbId
      )
  );

export const regenerateLocationSheetFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(
    zodValidator(
      castLocationInput.extend({
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
  .middleware([castAccessMiddleware])
  .validator(zodValidator(castLocationInput))
  .handler(
    async ({ context, data }): Promise<SheetStaleness> =>
      (
        await readReferenceStaleness(
          context.scopedDb,
          context.sequence?.id ?? null,
          'location',
          data.locationDbId
        )
      ).status
  );

/**
 * Replace a location of this sequence with another of the team's: the link
 * is re-pointed and the shots set there are re-rendered. No sheet is drawn.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        locationId: ulidSchema,
        withLocationId: ulidSchema,
      })
    )
  )
  .handler(({ context, data }) =>
    recastLocation(context.scopedDb, { userId: context.user.id }, data)
  );
