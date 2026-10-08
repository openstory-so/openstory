/**
 * The team's characters (#2017): the Characters page list, one character
 * with the sequences that cast it, its delete, and the writes made with no
 * sequence (#2065): create, bible and looks.
 */
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { characterBibleFieldsSchema } from '@/cast/bible-field';
import { lookFieldsSchema } from '@/cast/look-field';
import {
  createTeamCharacter,
  createTeamCharacterLook,
  deleteTeamCharacter,
  removeTeamCharacterLook,
  restoreTeamCharacterLook,
  updateTeamCharacter,
  updateTeamCharacterLook,
  restoreTeamCharacter,
} from '@/cast/server/cast-edit';
import {
  moveCastsToCurrent,
  previewVersionMove,
} from '@/cast/server/version-moves';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

const characterIdSchema = z.object({ characterId: ulidSchema });
const lookIdSchema = characterIdSchema.extend({ lookId: ulidSchema });
// The voice is designed in a sequence, so no voice field is taken here.
const teamBibleFieldsSchema = characterBibleFieldsSchema.omit({
  voiceDescription: true,
});
const nameSchema = z.string().trim().min(1).max(255);

/**
 * Which sequences cast the character, which are behind its current version,
 * and what moving each would change and cost at most (#2017).
 */
export const previewCharacterVersionMoveFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await previewVersionMove(
        context.scopedDb,
        data.characterId,
        await getEffectiveFalPricing()
      )
  );

/**
 * Move the chosen sequences to the character's current version ("Move
 * many"). A pointer write per sequence; nothing re-renders here.
 */
export const moveCharacterCastsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      characterIdSchema.extend({ sequenceIds: z.array(ulidSchema).min(1) })
    )
  )
  .handler(
    async ({ context, data }) =>
      await moveCastsToCurrent(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.sequenceIds
      )
  );

export const listTeamCharactersFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => await context.scopedDb.characters.listTeam());

export const getTeamCharacterFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    // Null, not an error: the page says "not found" for a character that is
    // gone or another team's.
    return await context.scopedDb.characters.getTeamCharacter(data.characterId);
  });

/**
 * How many shots the character is in, per sequence that casts it. Shots are
 * matched to a character by scene tags in memory, one sequence at a time, so
 * this is for the character's own page and never for a list.
 */
export const getTeamCharacterShotCountsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getTeamCharacter(
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

/** Delete a character no sequence casts. Soft: `restoreTeamCharacterFn` undoes it. */
export const deleteTeamCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await deleteTeamCharacter(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId
      )
  );

export const restoreTeamCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreTeamCharacter(context.scopedDb, data.characterId)
  );

/** Make a character with no sequence (#2065). */
export const createTeamCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(teamBibleFieldsSchema.extend({ name: nameSchema })))
  .handler(
    async ({ context, data }) =>
      await createTeamCharacter(
        context.scopedDb,
        { userId: context.user.id },
        data
      )
  );

/**
 * The character at its current version, with its looks: what the Characters
 * page edits while no sequence casts it. Null when gone or another team's.
 */
export const getCurrentTeamCharacterFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(
    async ({ context, data }) =>
      await context.scopedDb.characters.getCurrent(data.characterId)
  );

/** Edit a character's bible from no sequence: only its current version moves. */
export const updateTeamCharacterFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      teamBibleFieldsSchema.extend({
        characterId: ulidSchema,
        name: nameSchema.optional(),
        voiceOnly: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { characterId, ...fields } = data;
    return await updateTeamCharacter(
      context.scopedDb,
      { userId: context.user.id },
      characterId,
      fields
    );
  });

export const createTeamCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema.extend(lookFieldsSchema.shape)))
  .handler(
    async ({ context, data }) =>
      await createTeamCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data
      )
  );

export const updateTeamCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(lookIdSchema.extend(lookFieldsSchema.partial().shape))
  )
  .handler(
    async ({ context, data }) =>
      await updateTeamCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId,
        data
      )
  );

export const removeTeamCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(lookIdSchema))
  .handler(
    async ({ context, data }) =>
      await removeTeamCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId
      )
  );

export const restoreTeamCharacterLookFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(lookIdSchema))
  .handler(
    async ({ context, data }) =>
      await restoreTeamCharacterLook(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.lookId
      )
  );
