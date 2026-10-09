import { NotFoundError, ValidationError } from '@/platform/errors';
import type {
  CharacterLook,
  CharacterWithSheet,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';

/**
 * One look of a character (#2015), by id. A character an older worker wrote
 * has no look row yet: its default look answers to the character's own id
 * and is filled in here. A look of another character is not found.
 */
export async function requireCharacterLook(
  scopedDb: Pick<ScopedDb, 'characterLooks'>,
  character: Pick<CharacterWithSheet, 'id' | 'looks'>,
  lookId: string
): Promise<CharacterLook> {
  const look =
    character.looks.find((l) => l.id === lookId) ??
    (lookId === character.id
      ? await scopedDb.characterLooks.ensureDefault(character.id)
      : null);
  if (!look) {
    throw new NotFoundError(
      `Look ${lookId} not found for character ${character.id}`
    );
  }
  return look;
}

/**
 * A look that can be written to (#2015). A removed look is still read — a
 * scene may wear it, and restore finds it — but it is not edited, drawn or
 * uploaded to until it is restored: nobody could pick the result.
 */
export function requireLiveLook(look: CharacterLook): CharacterLook {
  if (look.deletedAt) {
    throw new ValidationError(
      `${look.name} was removed. Restore the look first.`
    );
  }
  return look;
}
