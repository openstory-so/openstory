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
import { ConflictError, NotFoundError } from '@/platform/errors';

/**
 * The one meaning of "a sequence casts this character" (#2017): a cast link
 * that is not removed, in a sequence that is not archived. `exceptSequenceId`
 * leaves one sequence out. `selectTeam` joins on the same two conditions, so
 * the list, the character page and the voice release agree.
 */
export const castElsewhere = (
  characterId: string,
  exceptSequenceId: string | null
) =>
  sql`EXISTS (SELECT 1 FROM sequence_cast o JOIN sequences os ON os.id = o.sequence_id WHERE o.character_id = ${characterId} AND o.removed_at IS NULL AND os.status != 'archived' AND (${exceptSequenceId} IS NULL OR o.sequence_id != ${exceptSequenceId}))`;

/**
 * Whether another sequence has ever cast the character: any link, removed
 * or in an archived sequence included. What analysis in `sequenceId` may
 * never rewrite (#2050). Wider than {@link heldElsewhere} on purpose: with
 * no library flag (#2065), a character attached here from a sequence that
 * has since been archived is still not this sequence's to rewrite.
 */
export const castEverElsewhere = async (
  db: Database,
  teamId: string,
  characterId: string,
  sequenceId: string
): Promise<boolean> => {
  const [row] = await db
    .select({
      shared: sql<number>`EXISTS (SELECT 1 FROM sequence_cast o WHERE o.character_id = ${characterId} AND o.sequence_id != ${sequenceId})`,
    })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.teamId, teamId)));
  if (!row) throw new NotFoundError(`Character ${characterId} not found`);
  return Boolean(row.shared);
};

/**
 * Whether a live sequence other than `exceptSequenceId` casts the character
 * ({@link castElsewhere}). What a sequence may not take the voice with when
 * it lets the character go. The character itself stays in the team either
 * way (#2065).
 */
export const heldElsewhere = async (
  db: Database,
  teamId: string,
  characterId: string,
  exceptSequenceId: string | null
): Promise<boolean> => {
  const [row] = await db
    .select({
      held: sql<number>`${castElsewhere(characterId, exceptSequenceId)}`,
    })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.teamId, teamId)));
  if (!row) throw new NotFoundError(`Character ${characterId} not found`);
  return Boolean(row.held);
};

/**
 * Refuse while a live cast member of the sequence, other than
 * `exceptCharacterId`, has this name (trimmed, case-blind). The script names
 * a character in capitals, and two of one name could not be told apart
 * (#2050). Attach, revive and restore all pass through here; analysis does
 * not, since it may make two characters of one name.
 */
export const assertNameFree = async (
  db: Database,
  sequenceId: string,
  name: string,
  exceptCharacterId: string | null
): Promise<void> => {
  const key = (value: string) => value.trim().toLowerCase();
  const live = await db
    .select({
      characterId: sequenceCast.characterId,
      name: characterBibleVersions.name,
    })
    .from(sequenceCast)
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
    )
    .where(
      and(
        eq(sequenceCast.sequenceId, sequenceId),
        sql`${sequenceCast.removedAt} IS NULL`
      )
    );
  if (
    live.some(
      (row) =>
        row.characterId !== exceptCharacterId &&
        row.name !== null &&
        key(row.name) === key(name)
    )
  ) {
    throw new ConflictError(
      `${name} is already a name in this sequence's cast. Rename one first.`
    );
  }
};

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
 * The team's characters that go when a sequence is hard-deleted: the ones
 * only it ever cast. Read before the delete, because the links that say so
 * are deleted first. A condition on `characters`.
 */
export const charactersOnlyIn = async (
  db: Database,
  teamId: string,
  sequenceId: string
): Promise<SQL> => {
  const rows = await db
    .select({ id: sequenceCast.characterId })
    .from(sequenceCast)
    .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
    .where(
      and(
        eq(sequenceCast.sequenceId, sequenceId),
        eq(characters.teamId, teamId),
        sql`NOT EXISTS (SELECT 1 FROM sequence_cast o WHERE o.character_id = ${sequenceCast.characterId} AND o.sequence_id != ${sequenceId})`
      )
    );
  // One bound parameter however many there are (D1 caps a statement at 100).
  const ids = JSON.stringify(rows.map((row) => row.id));
  return inArray(characters.id, sql`(SELECT value FROM json_each(${ids}))`);
};
