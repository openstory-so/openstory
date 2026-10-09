/**
 * Character looks (#2015): the outfits of one character. Each write calls
 * the function MCP calls (`@/cast/server/cast-edit`).
 */
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  createCharacterLook,
  removeCharacterLook,
  requireCharacter,
  restoreCharacterLook,
  selectCharacterLookVersion,
  updateCharacterLook,
} from '@/cast/server/cast-edit';
import { requireCharacterLook } from '@/cast/server/character-look';
import { lookFieldsSchema } from '@/cast/look-field';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

const characterInput = z.object({
  sequenceId: ulidSchema,
  characterId: ulidSchema,
});
const lookInput = characterInput.extend({ lookId: ulidSchema });

export const createCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterInput.extend(lookFieldsSchema.shape)))
  .handler(({ context, data }) =>
    createCharacterLook(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence.id,
      data.characterId,
      data
    )
  );

export const updateCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(lookInput.extend(lookFieldsSchema.partial().shape)))
  .handler(({ context, data }) =>
    updateCharacterLook(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence.id,
      data.characterId,
      data.lookId,
      data
    )
  );

export const removeCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(lookInput))
  .handler(({ context, data }) =>
    removeCharacterLook(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence.id,
      data.characterId,
      data.lookId
    )
  );

export const restoreCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(lookInput))
  .handler(({ context, data }) =>
    restoreCharacterLook(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence.id,
      data.characterId,
      data.lookId
    )
  );

export const selectCharacterLookVersionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(lookInput.extend({ versionId: ulidSchema })))
  .handler(({ context, data }) =>
    selectCharacterLookVersion(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence.id,
      data.characterId,
      data.lookId,
      data.versionId
    )
  );

/** A look's definition history, newest first, and which one is live. */
export const listCharacterLookVersionsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(lookInput))
  .handler(async ({ context, data }) => {
    const character = await requireCharacter(
      context.scopedDb,
      context.sequence.id,
      data.characterId
    );
    const look = await requireCharacterLook(
      context.scopedDb,
      character,
      data.lookId
    );
    return {
      selectedLookVersionId: look.lookVersionId,
      versions: await context.scopedDb.characterLooks.listVersions(look.id),
    };
  });
