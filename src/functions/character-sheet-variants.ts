import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { getGenerationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';

import { sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'character-sheet-variants']);

const variantInputSchema = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

/**
 * List active divergent character-sheet alternates across all characters in a
 * sequence. Drives the corner-dot indicator on talent cards and the inline
 * banner on the character detail view.
 */
export const getSequenceCharacterDivergentVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const characters = await context.scopedDb.characters.listWithTalent(
      context.sequence.id
    );
    if (characters.length === 0) return [];
    return context.scopedDb.characterSheetVariants.listDivergentActiveByCharacters(
      characters.map((c) => c.id)
    );
  });

/**
 * Promote a divergent character-sheet alternate into the live primary
 * `characters` row and soft-delete the variant. Emits `character-sheet:progress`
 * (`status: completed`) on the sequence channel so existing realtime listeners
 * refresh.
 */
export const promoteCharacterSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.characterSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Character sheet variant not found');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const character = await context.scopedDb.characters.getById(
      variant.characterId
    );
    if (!character || character.sequenceId !== context.sequence.id) {
      throw new Error('Character not found in this sequence');
    }

    await context.scopedDb.characterSheetVariants.promoteAtomically(
      variant.characterId,
      {
        sheetImageUrl: variant.url,
        sheetImagePath: variant.storagePath,
        sheetInputHash: variant.inputHash,
      },
      variant.id
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    try {
      await getGenerationChannel(context.sequence.id).emit(
        'generation.character-sheet:progress',
        {
          characterId: variant.characterId,
          status: 'completed',
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { variantId: variant.id, characterId: variant.characterId };
  });

export const discardCharacterSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.characterSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Character sheet variant not found');
    }
    const character = await context.scopedDb.characters.getById(
      variant.characterId
    );
    if (!character || character.sequenceId !== context.sequence.id) {
      throw new Error('Character not found in this sequence');
    }
    const discardedAt = await context.scopedDb.characterSheetVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardCharacterSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.characterSheetVariants.getById(
      data.variantId
    );
    if (!variant) {
      throw new Error('Character sheet variant not found');
    }
    const character = await context.scopedDb.characters.getById(
      variant.characterId
    );
    if (!character || character.sequenceId !== context.sequence.id) {
      throw new Error('Character not found in this sequence');
    }
    await context.scopedDb.characterSheetVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });
