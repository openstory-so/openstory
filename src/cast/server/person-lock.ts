/**
 * Whether a character must stay a person (#2065). One function decides it
 * for the read the bible form shows and for the edit the server refuses, so
 * the two cannot disagree. Whether an image shows a real person never comes
 * from the client: the talent's `isHuman` and the upload ledger answer.
 */
import { personLockMessage } from '@/cast/likeness';
import type { PersonLock } from '@/cast/likeness';
import { realPersonUrls } from '@/cast/server/upload-rights';
import { ConflictError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';

type LockLook = { deletedAt: Date | null; sheetImageUrl: string | null };
type Lockable = {
  /** The talent the character's bible version is cast with. */
  talent: { name: string; isHuman: boolean | null } | null;
  /** Its looks as one sequence casts them; none off no sequence. */
  looks: readonly LockLook[];
};

/** Each character's lock, in order. One ledger read for all of them. */
export async function personLocksOf(
  scopedDb: Pick<ScopedDb, 'compliance'>,
  characters: readonly Lockable[]
): Promise<(PersonLock | null)[]> {
  const castWithPerson = (character: Lockable) =>
    character.talent?.isHuman === true;
  const liveSheets = (character: Lockable) =>
    character.looks.flatMap((look) =>
      look.deletedAt === null && look.sheetImageUrl ? [look.sheetImageUrl] : []
    );
  const urls = characters
    .filter((character) => !castWithPerson(character))
    .flatMap(liveSheets);
  const real =
    urls.length === 0
      ? new Set<string>()
      : await realPersonUrls(scopedDb, urls);
  return characters.map((character) => {
    if (character.talent && castWithPerson(character)) {
      return { reason: 'talent', talentName: character.talent.name };
    }
    return liveSheets(character).some((url) => real.has(url))
      ? { reason: 'upload' }
      : null;
  });
}

/** One character's lock, by the talent id its bible version carries. */
export async function personLockOf(
  scopedDb: Pick<ScopedDb, 'compliance' | 'talent'>,
  character: { talentId: string | null; looks: readonly LockLook[] }
): Promise<PersonLock | null> {
  const talent = character.talentId
    ? ((await scopedDb.talent.getById(character.talentId)) ?? null)
    : null;
  const [lock] = await personLocksOf(scopedDb, [
    { talent, looks: character.looks },
  ]);
  return lock ?? null;
}

/**
 * Refuse an edit that would make a locked character not a person. Setting
 * it to a person, or leaving the field out, is always allowed.
 */
export async function requirePersonEditAllowed(
  scopedDb: Pick<ScopedDb, 'compliance' | 'talent'>,
  update: { isPerson?: boolean | null },
  character: { talentId: string | null; looks: readonly LockLook[] }
): Promise<void> {
  if (update.isPerson !== false) return;
  const lock = await personLockOf(scopedDb, character);
  if (lock) throw new ConflictError(personLockMessage(lock));
}
