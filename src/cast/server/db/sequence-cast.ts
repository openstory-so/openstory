/**
 * Sequence cast (#2017): the links between a sequence and the team
 * characters it uses.
 *
 * A link holds only what is the sequence's: the script id, the soft-remove
 * and whether the writer attached the character. Everything else — the
 * bible, the voice, the looks and their sheets — is the character's, read
 * at its current version by every sequence that casts it. The characters
 * and looks modules read and write the links; this file holds what they
 * share.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characters,
  sequenceCast,
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
 * Whether the character is not `sequenceId`'s to rewrite (#2050, #2065):
 * the writer attached it here (the link's `attached`), or another sequence
 * has ever cast it, a removed link or an archived sequence included. Analysis
 * in `sequenceId` links such a character and never edits it. Wider than
 * {@link castElsewhere} on purpose: a character attached here from a sequence
 * that has since been archived is still not this sequence's to rewrite, and
 * nor is one made on the Characters page that only this sequence casts.
 */
export const analysisMayNotRewrite = async (
  db: Database,
  teamId: string,
  characterId: string,
  sequenceId: string
): Promise<boolean> => {
  const [row] = await db
    .select({
      shared: sql<number>`EXISTS (SELECT 1 FROM sequence_cast o WHERE o.character_id = ${characterId} AND (o.sequence_id != ${sequenceId} OR o.attached))`,
    })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.teamId, teamId)));
  if (!row) throw new NotFoundError(`Character ${characterId} not found`);
  return Boolean(row.shared);
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
    .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, characters.selectedBibleVersionId)
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
 * The characters played by a talent: the ones whose current bible version
 * names it. A condition on `characters`, for `demoteCharacterSheetClaims`.
 */
export const castOfTalent = (db: Database, talentId: string): SQL =>
  inArray(
    characters.selectedBibleVersionId,
    db
      .select({ id: characterBibleVersions.id })
      .from(characterBibleVersions)
      .where(eq(characterBibleVersions.talentId, talentId))
  );

/**
 * Delete the cast links `where` matches. They RESTRICT their parents' delete
 * (the #612 rebuild trap), so this goes before the sequence's or the
 * character's, in the same batch.
 */
export const deleteCastStatements = (db: Database, where: SQL) =>
  [db.delete(sequenceCast).where(where)] as const;

/**
 * The team's characters that go when a sequence is hard-deleted: the ones
 * only it ever cast and the writer did not attach. Read before the delete, because the links that say so
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
        // An attached character is the team's, whoever else casts it (#2065).
        eq(sequenceCast.attached, false),
        sql`NOT EXISTS (SELECT 1 FROM sequence_cast o WHERE o.character_id = ${sequenceCast.characterId} AND o.sequence_id != ${sequenceId})`
      )
    );
  // One bound parameter however many there are (D1 caps a statement at 100).
  const ids = JSON.stringify(rows.map((row) => row.id));
  return inArray(characters.id, sql`(SELECT value FROM json_each(${ids}))`);
};
