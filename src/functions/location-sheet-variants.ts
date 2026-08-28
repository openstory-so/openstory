import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { getGenerationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';

import { sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'location-sheet-variants']);

const variantInputSchema = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

const locationVersionsInput = z.object({
  sequenceId: ulidSchema,
  locationDbId: ulidSchema,
});

export const listLocationSheetVersionsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationVersionsInput))
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!location || location.sequenceId !== context.sequence.id) {
      throw new Error('Location not found in this sequence');
    }
    const rows =
      await context.scopedDb.locationSheetVariants.listHistoryByParent(
        'sequence_location',
        location.id
      );
    return {
      selectedReferenceVersionId: location.selectedReferenceVersionId,
      versions: rows,
    };
  });

export const selectLocationSheetVersionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(locationVersionsInput.extend({ versionId: ulidSchema }))
  )
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!location || location.sequenceId !== context.sequence.id) {
      throw new Error('Location not found in this sequence');
    }
    const version = await context.scopedDb.locationSheetVariants.select(
      location.id,
      data.versionId,
      { actorId: context.user.id }
    );
    try {
      await getGenerationChannel(context.sequence.id).emit(
        'generation.location-sheet:progress',
        { locationId: location.id, status: 'completed' }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }
    return { versionId: version.id, locationDbId: location.id };
  });

/**
 * List active divergent location-sheet alternates across all sequence
 * locations in this sequence. Drives the corner-dot indicator on location
 * cards and the banner on the location detail view.
 */
export const getSequenceLocationDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const locations = await context.scopedDb.sequenceLocations.list(
      context.sequence.id
    );
    if (locations.length === 0) return [];
    return context.scopedDb.locationSheetVariants.listDivergentActiveByParents(
      'sequence_location',
      locations.map((l) => l.id)
    );
  });

export const promoteSequenceLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'sequence_location') {
      throw new Error('Sequence-location variant not found');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const location = await context.scopedDb.sequenceLocations.getById(
      variant.parentId
    );
    if (!location || location.sequenceId !== context.sequence.id) {
      throw new Error('Sequence location not found in this sequence');
    }

    await context.scopedDb.locationSheetVariants.select(
      variant.parentId,
      variant.id,
      { actorId: context.user.id }
    );

    try {
      await getGenerationChannel(context.sequence.id).emit(
        'generation.location-sheet:progress',
        {
          locationId: variant.parentId,
          status: 'completed',
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { variantId: variant.id, locationId: variant.parentId };
  });

export const discardSequenceLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'sequence_location') {
      throw new Error('Sequence-location variant not found');
    }
    const location = await context.scopedDb.sequenceLocations.getById(
      variant.parentId
    );
    if (!location || location.sequenceId !== context.sequence.id) {
      throw new Error('Sequence location not found in this sequence');
    }
    const discardedAt = await context.scopedDb.locationSheetVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardSequenceLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'sequence_location') {
      throw new Error('Sequence-location variant not found');
    }
    const location = await context.scopedDb.sequenceLocations.getById(
      variant.parentId
    );
    if (!location || location.sequenceId !== context.sequence.id) {
      throw new Error('Sequence location not found in this sequence');
    }
    await context.scopedDb.locationSheetVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });
