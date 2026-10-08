/**
 * Whether a character must stay a person (#2065). One function decides it
 * for the reads the bible form shows and for the edit the server refuses, so
 * they cannot disagree. Whether an image shows a real person never comes
 * from the client: the talent's `isHuman` and the upload ledger answer.
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
type Lockable = {
  id: string;
  /** The talent the character's bible version is cast with. */
  talent: { name: string; isHuman: boolean | null } | null;
};

/**
 * Each character's lock, in order. Two reads for all of them: their sheets
 * in every sequence, then the ledger.
 */
export async function personLocksOf(
  scopedDb: LockDb,
  characters: readonly Lockable[]
): Promise<(PersonLock | null)[]> {
  const sheets = await scopedDb.characterLooks.listCastSheetUrls(
    characters
      .filter((character) => character.talent?.isHuman !== true)
      .map((character) => character.id)
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
  return characters.map((character) => {
    if (character.talent?.isHuman === true) {
      return { reason: 'talent', talentName: character.talent.name };
    }
    return photographed.has(character.id) ? { reason: 'upload' } : null;
  });
}

/** One character's lock, by the talent id its bible version carries. */
export async function personLockOf(
  scopedDb: LockDb & Pick<ScopedDb, 'talent'>,
  character: { id: string; talentId: string | null }
): Promise<PersonLock | null> {
  const talent = character.talentId
    ? ((await scopedDb.talent.getById(character.talentId)) ?? null)
    : null;
  const [lock] = await personLocksOf(scopedDb, [{ id: character.id, talent }]);
  return lock ?? null;
}

/**
 * Refuse an edit that would make a locked character not a person. Setting
 * it to a person, or leaving the field out, is always allowed.
 */
export async function requirePersonEditAllowed(
  scopedDb: LockDb & Pick<ScopedDb, 'talent'>,
  update: { isPerson?: boolean | null },
  character: { id: string; talentId: string | null }
): Promise<void> {
  if (update.isPerson !== false) return;
  const lock = await personLockOf(scopedDb, character);
  if (lock) throw new ConflictError(personLockMessage(lock));
}

/**
 * The same check again, after the edit wrote `isPerson: false`. D1 has no
 * interactive transaction, so a recast or an uploaded sheet can land between
 * {@link requirePersonEditAllowed} and the write. If the character is locked
 * now, `putBack` writes it a person again and the edit is refused.
 *
 * Not covered: an upload whose sheet lands after this re-check, having read
 * the character as a person before the edit (it then writes no bible
 * version). The same user would have to race their own two requests.
 */
export async function requirePersonEditStillAllowed(
  scopedDb: LockDb & Pick<ScopedDb, 'talent'>,
  update: { isPerson?: boolean | null },
  character: { id: string; talentId: string | null },
  putBack: () => Promise<unknown>
): Promise<void> {
  if (update.isPerson !== false) return;
  const lock = await personLockOf(scopedDb, character);
  if (!lock) return;
  await putBack();
  throw new ConflictError(personLockMessage(lock));
}
