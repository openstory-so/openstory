import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { castChannelId } from '@/cast/cast-channel';
import { getGenerationChannel } from '@/platform/realtime';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

import { castAccessMiddleware } from '@/platform/middleware.fn';
import {
  discardCharacterSheetVersion,
  requireCharacter,
  selectCharacterSheetVersion,
  undiscardCharacterSheetVersion,
} from '@/cast/server/cast-edit';

import { requireCharacterLook } from '@/cast/server/character-look';
import { keepLockedCharacterAPerson } from '@/cast/server/person-lock';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'serverFn', 'character-sheet-variants']);

// `sequenceId` null is the Characters page (#2017): the same sheets, which
// are the character's, with no sequence event or channel.
const variantInputSchema = z.object({
  sequenceId: ulidSchema.nullable(),
  variantId: ulidSchema,
});

const characterVersionsInput = z.object({
  sequenceId: ulidSchema.nullable(),
  characterId: ulidSchema,
  // The look whose sheets to list (#2015); the default look when omitted.
  lookId: ulidSchema.optional(),
});

/** Completed, non-discarded sheet versions for the history list. */
export const listCharacterSheetVersionsFn = createServerFn({ method: 'GET' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(characterVersionsInput))
  .handler(async ({ context, data }) => {
    const character = await requireCharacter(
      context.scopedDb,
      context.sequence?.id ?? null,
      data.characterId
    );
    const look = await requireCharacterLook(
      context.scopedDb,
      character,
      data.lookId ?? character.lookId
    );
    // This sequence's strip: the sheets it made or selected (#2017).
    const rows =
      await context.scopedDb.characterSheetVariants.listHistoryByLook(look.id);
    return {
      selectedSheetVersionId: look.selectedSheetVersionId,
      versions: rows,
    };
  });

export const selectCharacterSheetVersionFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
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
        context.sequence?.id ?? null,
        data.characterId,
        data.versionId
      )
  );

/** One character's live divergent alternates: the detail view's banner (#2017). */
export const getCharacterDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(characterVersionsInput.omit({ lookId: true })))
  .handler(async ({ context, data }) => {
    const character = await requireCharacter(
      context.scopedDb,
      context.sequence?.id ?? null,
      data.characterId
    );
    return await context.scopedDb.characterSheetVariants.listDivergentActiveByCharacter(
      character.id
    );
  });

/**
 * Promote a divergent character-sheet alternate into the live primary
 * `characters` row and soft-delete the variant. Emits `character-sheet:progress`
 * (`status: completed`) on the cast channel so existing realtime listeners
 * refresh.
 */
export const promoteCharacterSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
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

    const sequenceId = context.sequence?.id ?? null;
    const character = await requireCharacter(
      context.scopedDb,
      sequenceId,
      variant.characterId
    );

    await context.scopedDb.characterSheetVariants.select(
      sequenceId,
      variant.characterId,
      variant.id,
      { actorId: context.user.id }
    );
    // As every sheet select does (`selectCharacterSheetVersion`, #2065).
    await keepLockedCharacterAPerson(
      context.scopedDb,
      { userId: context.user.id },
      sequenceId,
      character
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    try {
      await getGenerationChannel(
        castChannelId(sequenceId, variant.characterId)
      ).emit('generation.character-sheet:progress', {
        characterId: variant.characterId,
        lookId: variant.lookId ?? variant.characterId,
        status: 'completed',
      });
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { variantId: variant.id, characterId: variant.characterId };
  });

export const discardCharacterSheetVariantFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await discardCharacterSheetVersion(
        context.scopedDb,
        context.sequence?.id ?? null,
        data.variantId
      )
  );

export const undiscardCharacterSheetVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([castAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await undiscardCharacterSheetVersion(
        context.scopedDb,
        context.sequence?.id ?? null,
        data.variantId
      )
  );
