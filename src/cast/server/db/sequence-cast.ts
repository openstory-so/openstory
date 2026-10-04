/**
 * Sequence cast (#2017): the links between a sequence and the team
 * characters it uses.
 *
 * Everything a sequence decides about a character is on `sequence_cast` (the
 * pinned bible version, the script id, the soft-remove) and
 * `sequence_cast_looks` (the pinned look version, the sheet pointer, the
 * sheet claim). The characters, looks and sheet-claim modules read and write
 * those; this file holds what they share.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characters,
  sequenceCast,
  sequenceCastLooks,
} from '@/platform/server/db/schema';

/**
 * The cast links played by a talent: the ones whose pinned bible version
 * names it. For `demoteCharacterSheetClaims`.
 */
export const castOfTalent = (db: Database, talentId: string): SQL =>
  inArray(
    sequenceCast.bibleVersionId,
    db
      .select({ id: characterBibleVersions.id })
      .from(characterBibleVersions)
      .where(eq(characterBibleVersions.talentId, talentId))
  );

/**
 * Delete the cast links `where` matches, and their cast looks. Both RESTRICT
 * their parents' delete (the #612 rebuild trap), so these go before the
 * sequence's, the character's or the look's, in the same batch.
 */
export const deleteCastStatements = (db: Database, where: SQL) =>
  [
    db
      .delete(sequenceCastLooks)
      .where(
        inArray(
          sequenceCastLooks.castId,
          db.select({ id: sequenceCast.id }).from(sequenceCast).where(where)
        )
      ),
    db.delete(sequenceCast).where(where),
  ] as const;

/**
 * The characters that go when a sequence does: the ones only it casts and
 * the library does not hold. Read before the delete, because the links that
 * say so are deleted first. A condition on `characters`.
 */
export const charactersOnlyIn = async (
  db: Database,
  sequenceId: string
): Promise<SQL> => {
  const rows = await db
    .select({ id: sequenceCast.characterId })
    .from(sequenceCast)
    .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
    .where(
      and(
        eq(sequenceCast.sequenceId, sequenceId),
        eq(characters.inLibrary, false),
        sql`NOT EXISTS (SELECT 1 FROM sequence_cast o WHERE o.character_id = ${sequenceCast.characterId} AND o.sequence_id != ${sequenceId})`
      )
    );
  // One bound parameter however many there are (D1 caps a statement at 100).
  const ids = JSON.stringify(rows.map((row) => row.id));
  return inArray(characters.id, sql`(SELECT value FROM json_each(${ids}))`);
};
