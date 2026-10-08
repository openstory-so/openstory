/**
 * The team's characters (#2017): the Characters page list, one character
 * with the sequences that cast it, and the library flag.
 */
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { setCharacterInLibrary } from '@/cast/server/cast-edit';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

const characterIdSchema = z.object({ characterId: ulidSchema });

export const listTeamCharactersFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ inLibrary: z.boolean() })))
  .handler(
    async ({ context, data }) =>
      await context.scopedDb.characters.listTeam({ inLibrary: data.inLibrary })
  );

export const getTeamCharacterFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    // Null, not an error: the page says "not found" for a character that is
    // gone, another team's, or held by nothing (not in the library and cast
    // in no live sequence).
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

/**
 * Put a character in the team library, or take it out. A flag on the
 * character itself: nothing is copied and no talent is made.
 */
export const setCharacterInLibraryFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(characterIdSchema.extend({ inLibrary: z.boolean() })))
  .handler(
    async ({ context, data }) =>
      await setCharacterInLibrary(
        context.scopedDb,
        { userId: context.user.id },
        data.characterId,
        data.inLibrary
      )
  );
