import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { getGenerationChannel } from '@/platform/realtime';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import {
  discardCharacterSheetVersion,
  selectCharacterSheetVersion,
  undiscardCharacterSheetVersion,
} from '@/cast/server/cast-edit';

import { requireCharacterLook } from '@/cast/server/character-look';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'serverFn', 'character-sheet-variants']);

const variantInputSchema = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

const characterVersionsInput = z.object({
  sequenceId: ulidSchema,
  characterId: ulidSchema,
  // The look whose sheets to list (#2015); the default look when omitted.
  lookId: ulidSchema.optional(),
});

/** Completed, non-discarded sheet versions for the history list. */
export const listCharacterSheetVersionsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterVersionsInput))
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      context.sequence.id,
      data.characterId
    );
    if (!character) {
      throw new Error('Character not found in this sequence');
    }
    const look = await requireCharacterLook(
      context.scopedDb,
      character,
      data.lookId ?? character.lookId
    );
    const rows =
      await context.scopedDb.characterSheetVariants.listHistoryByLook(look.id);
    return {
      selectedSheetVersionId: look.selectedSheetVersionId,
      versions: rows,
    };
  });

export const selectCharacterSheetVersionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      characterVersionsInput
        .omit({ lookId: true })
        .extend({ versionId: ulidSchema })
    )
  )
  .handler(
    async ({ context, data }) =>
      await selectCharacterSheetVersion(
        context.scopedDb,
        { userId: context.user.id },
        context.sequence.id,
        data.characterId,
        data.versionId
      )
  );

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
      context.sequence.id,
      variant.characterId
    );
    if (!character) {
      throw new Error('Character not found in this sequence');
    }

    await context.scopedDb.characterSheetVariants.select(
      context.sequence.id,
      variant.characterId,
      variant.id,
      { actorId: context.user.id }
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    try {
      await getGenerationChannel(context.sequence.id).emit(
        'generation.character-sheet:progress',
        {
          characterId: variant.characterId,
          lookId: variant.lookId ?? variant.characterId,
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
  .handler(
    async ({ data, context }) =>
      await discardCharacterSheetVersion(
        context.scopedDb,
        context.sequence.id,
        data.variantId
      )
  );

export const undiscardCharacterSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await undiscardCharacterSheetVersion(
        context.scopedDb,
        context.sequence.id,
        data.variantId
      )
  );
