import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { getLocationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';

import { authWithTeamMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger([
  'openstory',
  'serverFn',
  'library-location-sheet-variants',
]);

const variantInputSchema = z.object({
  variantId: ulidSchema,
});

/**
 * List active divergent variants for all library locations the team can see.
 * Drives the corner-dot indicator on `location-library-card`.
 */
export const getLibraryLocationDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const locations = await context.scopedDb.locations.list();
    if (locations.length === 0) return [];
    return context.scopedDb.locationSheetVariants.listDivergentActiveByParents(
      'library_location',
      locations.map((l) => l.id)
    );
  });

export const promoteLibraryLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'library_location') {
      throw new Error('Library location variant not found');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    // ACL check: scopedDb.locations.getById filters by team / public visibility
    // so a user without access gets `null` here.
    const location = await context.scopedDb.locations.getById(variant.parentId);
    if (!location) {
      throw new Error('Library location not found');
    }

    await context.scopedDb.locationSheetVariants.promoteAtomically(
      'library_location',
      variant.parentId,
      {
        referenceImageUrl: variant.url,
        referenceImagePath: variant.storagePath,
        referenceInputHash: variant.inputHash,
      },
      variant.id
    );

    try {
      await getLocationChannel(variant.parentId).emit(
        'location.sheet:progress',
        {
          locationId: variant.parentId,
          status: 'completed',
          sheetImageUrl: variant.url,
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { variantId: variant.id, locationId: variant.parentId };
  });

export const discardLibraryLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'library_location') {
      throw new Error('Library location variant not found');
    }
    const location = await context.scopedDb.locations.getById(variant.parentId);
    if (!location) {
      throw new Error('Library location not found');
    }
    const discardedAt = await context.scopedDb.locationSheetVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardLibraryLocationSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.locationSheetVariants.getById(
      data.variantId
    );
    if (!variant || variant.parentType !== 'library_location') {
      throw new Error('Library location variant not found');
    }
    const location = await context.scopedDb.locations.getById(variant.parentId);
    if (!location) {
      throw new Error('Library location not found');
    }
    await context.scopedDb.locationSheetVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });
