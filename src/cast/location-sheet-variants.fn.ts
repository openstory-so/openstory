import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { ulidSchema } from '@/platform/server/schemas/id.schemas';

import {
  castAccessMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';
import {
  discardLocationSheetVersion,
  requireLocation,
  selectLocationSheetVersion,
  undiscardLocationSheetVersion,
} from '@/cast/server/cast-edit';

// `sequenceId` null is the Locations page (#1695): the same sheets, which
// are the location's, with no sequence event or channel.
const variantInputSchema = z.object({
  sequenceId: ulidSchema.nullable(),
  variantId: ulidSchema,
});

const locationVersionsInput = z.object({
  sequenceId: ulidSchema.nullable(),
  locationDbId: ulidSchema,
});

/** Completed, non-discarded sheet versions for the history list. */
export const listLocationSheetVersionsFn = createServerFn({ method: 'GET' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(locationVersionsInput))
  .handler(async ({ context, data }) => {
    const location = await requireLocation(
      context.scopedDb,
      context.sequence?.id ?? null,
      data.locationDbId
    );
    const rows =
      await context.scopedDb.locationSheetVariants.listHistoryByLocation(
        location.id
      );
    return {
      selectedReferenceVersionId: location.selectedReferenceVersionId,
      versions: rows,
    };
  });

export const selectLocationSheetVersionFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(
    zodValidator(locationVersionsInput.extend({ versionId: ulidSchema }))
  )
  .handler(
    async ({ context, data }) =>
      await selectLocationSheetVersion(
        context.scopedDb,
        { userId: context.user.id },
        context.sequence?.id ?? null,
        data.locationDbId,
        data.versionId
      )
  );

/**
 * Active divergent location-sheet alternates across every location this
 * sequence uses. Drives the corner-dot indicator on location cards.
 */
export const getSequenceLocationDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const locations = await context.scopedDb.locations.list(
      context.sequence.id
    );
    return await context.scopedDb.locationSheetVariants.listDivergentActiveByLocations(
      locations.map((l) => l.id)
    );
  });

/** One location's live divergent alternates: the detail view's banner. */
export const getLocationDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(locationVersionsInput))
  .handler(async ({ context, data }) => {
    const location = await requireLocation(
      context.scopedDb,
      context.sequence?.id ?? null,
      data.locationDbId
    );
    return await context.scopedDb.locationSheetVariants.listDivergentActiveByLocation(
      location.id
    );
  });

/**
 * Make a divergent alternate the location's live sheet. Emits
 * `location-sheet:progress` (`completed`) on the location's channel so the
 * existing realtime listeners refresh.
 */
export const promoteLocationSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Location sheet variant not found');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    await selectLocationSheetVersion(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence?.id ?? null,
      variant.locationId,
      variant.id
    );
    return { variantId: variant.id, locationId: variant.locationId };
  });

export const discardLocationSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await discardLocationSheetVersion(
        context.scopedDb,
        context.sequence?.id ?? null,
        data.variantId
      )
  );

export const undiscardLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([castAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await undiscardLocationSheetVersion(
        context.scopedDb,
        context.sequence?.id ?? null,
        data.variantId
      )
  );
