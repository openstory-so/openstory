/**
 * The organization's characters (#2017): the Characters page list, one character
 * with the sequences that cast it, its delete, and the writes made with no
 * sequence (#2065): create, bible and looks.
 */
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { characterBibleFieldsSchema } from '@/cast/bible-field';
import { lookFieldsSchema } from '@/cast/look-field';
import {
  createOrganizationCharacter,
  createOrganizationCharacterLook,
  deleteOrganizationCharacter,
  removeOrganizationCharacterLook,
  restoreOrganizationCharacterLook,
  updateOrganizationCharacter,
  updateOrganizationCharacterLook,
  restoreOrganizationCharacter,
} from '@/cast/server/cast-edit';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

const characterIdSchema = z.object({ characterId: ulidSchema });
const lookIdSchema = characterIdSchema.extend({ lookId: ulidSchema });
// A new character has no voice yet; an edit may describe one (#2017).
const organizationBibleFieldsSchema = characterBibleFieldsSchema.omit({
  voiceDescription: true,
});
const nameSchema = z.string().trim().min(1).max(255);

export const listOrganizationCharactersFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .handler(
    async ({ context }) => await context.scopedDb.characters.listOrganization()
  );

export const getOrganizationCharacterFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    // Null, not an error: the page says "not found" for a character that is
    // gone or another organization's.
    return await context.scopedDb.characters.getOrganizationCharacter(
      data.characterId
    );
  });

/**
 * How many shots the character is in, per sequence that casts it. Shots are
 * matched to a character by scene tags in memory, one sequence at a time, so
 * this is for the character's own page and never for a list.
 */
export const getOrganizationCharacterShotCountsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    const character =
      await context.scopedDb.characters.getOrganizationCharacter(
        data.characterId
      );
    const counts: Record<string, number> = {};
    if (!character) return counts;
    // ponytail: every shot of every casting sequence is loaded; give scene tags the cast id when a character is in hundreds.
    for (const sequence of character.sequences) {
      const shotIds = await context.scopedDb.characters.getShotIdsForCharacter(
        sequence.id,
        character.id
      );
      counts[sequence.id] = shotIds.length;
    }
    return counts;
  });

/** Delete a character no sequence casts. Soft: `restoreOrganizationCharacterFn` undoes it. */
export const deleteOrganizationCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await deleteOrganizationCharacter(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId
      )
  );

export const restoreOrganizationCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreOrganizationCharacter(context.scopedDb, data.characterId)
  );

/** Make a character with no sequence (#2065). */
export const createOrganizationCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      organizationBibleFieldsSchema.extend({
        name: nameSchema,
        // Required here: no sequence style to take it from (#2017).
        rendering: z.string().trim().min(1).max(2000),
      })
    )
  )
  .handler(
    async ({ context, data }) =>
      await createOrganizationCharacter(
        context.scopedDb,
        { userId: context.user.id },
        data
      )
  );

/** Edit a character's bible from no sequence: only its current version moves. */
export const updateOrganizationCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      characterBibleFieldsSchema.extend({
        characterId: ulidSchema,
        name: nameSchema.optional(),
        voiceOnly: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { characterId, ...fields } = data;
    return await updateOrganizationCharacter(
      context.scopedDb,
      { userId: context.user.id },
      characterId,
      fields
    );
  });

export const createOrganizationCharacterLookFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(characterIdSchema.extend(lookFieldsSchema.shape)))
  .handler(
    async ({ context, data }) =>
      await createOrganizationCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data
      )
  );

export const updateOrganizationCharacterLookFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(lookIdSchema.extend(lookFieldsSchema.partial().shape))
  )
  .handler(
    async ({ context, data }) =>
      await updateOrganizationCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId,
        data
      )
  );

export const removeOrganizationCharacterLookFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(lookIdSchema))
  .handler(
    async ({ context, data }) =>
      await removeOrganizationCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId
      )
  );

export const restoreOrganizationCharacterLookFn = createServerFn({
  method: 'POST',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(lookIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreOrganizationCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId
      )
  );
