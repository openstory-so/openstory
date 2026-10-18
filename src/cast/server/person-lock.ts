/**
 * Whether a character must stay a person (#2065). One function decides it
 * for the reads the bible form shows and for the edit the server refuses, so
 * they cannot disagree. Whether an image shows a real person never comes
 * from the client: the upload ledger answers.
 *
 * The sheets that count are the character's in EVERY sequence, not only the
 * one being edited: a bible version is shared, so a version made not a
 * person in one sequence can be adopted by another whose sheet is a real
 * person's photo (Update this sequence).
 */
import { personLockMessage } from '@/cast/likeness';
import type { PersonLock } from '@/cast/likeness';
import { realPersonUrls } from '@/cast/server/upload-rights';
import { ConflictError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';

type LockDb = Pick<ScopedDb, 'compliance' | 'characterLooks'>;

/**
 * Each character's lock, in order. Two reads for all of them: their sheets
 * in every sequence, then the ledger.
 */
export async function personLocksOf(
  scopedDb: LockDb,
  characters: readonly { id: string }[]
): Promise<(PersonLock | null)[]> {
  const sheets = await scopedDb.characterLooks.listCastSheetUrls(
    characters.map((character) => character.id)
  );
  const real =
    sheets.length === 0
      ? new Set<string>()
      : await realPersonUrls(
          scopedDb,
          sheets.map((sheet) => sheet.url)
        );
  const photographed = new Set(
    sheets
      .filter((sheet) => real.has(sheet.url))
      .map((sheet) => sheet.characterId)
  );
  return characters.map((character) =>
    photographed.has(character.id) ? { reason: 'upload' } : null
  );
}

/** One character's lock, from the upload ledger. */
export async function personLockOf(
  scopedDb: LockDb,
  character: { id: string }
): Promise<PersonLock | null> {
  const [lock] = await personLocksOf(scopedDb, [character]);
  return lock ?? null;
}

/**
 * A bible edit of a character, as the lock allows it. Computed on EVERY
 * edit, not only one that sends `isPerson`:
 *
 * - `isPerson: false` on a locked character is refused;
 * - any other edit of a locked character writes a person. The new version is
 *   built from the version the editing sequence pins, which may be an older
 *   one that says not a person (another sequence's upload made the newer
 *   one), and a row stored wrong repairs itself on its next save.
 *
 * An unlocked character's edit comes back as it was sent.
 */
export async function lockedPersonEdit<U extends { isPerson?: boolean | null }>(
  scopedDb: LockDb,
  update: U,
  character: { id: string }
): Promise<U> {
  const lock = await personLockOf(scopedDb, character);
  if (!lock) return update;
  if (update.isPerson === false) {
    throw new ConflictError(personLockMessage(lock));
  }
  return { ...update, isPerson: true };
}

/**
 * A locked character stored as not a person is written a person (#2065),
 * BEFORE a write that would carry its version forward or pin a sequence to
 * it, and after one that locks it:
 *
 * - a default look's styling edit copies the bible version forward
 *   (`legacyFeaturesMove`);
 * - a version move pins a sequence, whose sheet may be a real person's
 *   photo, to the current version;
 * - selecting an uploaded photo of a real person locks the character.
 *
 * `sequenceId` is whose version `character` was read at: the one that
 * sequence pins, or the current one from no sequence (`null`). When in
 * doubt, a person: over-registering is the safe direction.
 */
export async function keepLockedCharacterAPerson(
  scopedDb: LockDb & Pick<ScopedDb, 'characters'>,
  actor: { userId: string },
  sequenceId: string | null,
  character: { id: string; isPerson: boolean }
): Promise<void> {
  if (character.isPerson) return;
  if (!(await personLockOf(scopedDb, character))) return;
  const opts = { actorId: actor.userId, source: 'edit' as const };
  if (sequenceId === null) {
    await scopedDb.characters.updateBible(
      null,
      character.id,
      { isPerson: true },
      opts
    );
  } else {
    await scopedDb.characters.updateBible(
      sequenceId,
      character.id,
      { isPerson: true },
      opts
    );
  }
}

/**
 * The same check again, after the edit wrote `isPerson: false`. D1 has no
 * interactive transaction, so an uploaded sheet can land between
 * {@link lockedPersonEdit} and the write. If the character is locked
 * now, `putBack` writes it a person again and the edit is refused.
 *
 * Not covered: an upload whose sheet lands after this re-check, having read
 * the character as a person before the edit (it then writes no bible
 * version). The same user would have to race their own two requests.
 */
export async function requirePersonEditStillAllowed(
  scopedDb: LockDb,
  update: { isPerson?: boolean | null },
  character: { id: string },
  putBack: () => Promise<unknown>
): Promise<void> {
  if (update.isPerson !== false) return;
  const lock = await personLockOf(scopedDb, character);
  if (!lock) return;
  await putBack();
  throw new ConflictError(personLockMessage(lock));
}
