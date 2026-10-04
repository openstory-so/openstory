/**
 * The #2017 cast backfill, for rows written after the migration ran.
 */

import { count, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  characterLooks,
  characters,
  sequenceCast,
  sequenceCastLooks,
} from '@/platform/server/db/schema';

/**
 * Give what a worker older than #2017 wrote during the deploy its place in
 * the cast: the team on a character, the talent on its bible version, a cast
 * link per character and a cast look per look. The same statements as the
 * `backfill_team_characters_cast` migration, and as replay-safe: each one
 * only touches rows that have none yet, and a link or cast look reuses its
 * character's or look's id.
 *
 * This is the ONLY reader of the legacy cast columns on `characters` and
 * `character_looks`. It runs from the reconcile cron, and on the two write
 * paths that can meet such a row before the cron has. It goes when those
 * columns do.
 *
 * Returns how many characters and looks had no place yet; nothing is written
 * when that is none.
 */
export async function backfillCast(db: Database): Promise<number> {
  const [unlinked] = await db
    .select({ n: count() })
    .from(characters)
    .leftJoin(sequenceCast, eq(sequenceCast.characterId, characters.id))
    .where(isNull(sequenceCast.id));
  const [uncast] = await db
    .select({ n: count() })
    .from(characterLooks)
    .leftJoin(
      sequenceCastLooks,
      eq(sequenceCastLooks.lookId, characterLooks.id)
    )
    .where(isNull(sequenceCastLooks.id));
  const found = (unlinked?.n ?? 0) + (uncast?.n ?? 0);
  if (found === 0) return 0;
  // A character with no bible version (a worker older than #1600) gets one,
  // as that backfill made them, so its link can pin it.
  await db.run(sql`
    INSERT INTO character_bible_versions
      (id, character_id, name, age, gender, ethnicity, physical_description,
       standard_clothing, distinguishing_features, personality, movement,
       voice_only, is_person, consistency_tag, source, created_at, created_by)
    SELECT c.id, c.id, c.name, c.age, c.gender, c.ethnicity, c.physical_description,
      c.standard_clothing, c.distinguishing_features, c.personality, c.movement,
      c.voice_only, c.is_person, c.consistency_tag, 'backfill', c.updated_at, NULL
    FROM characters c
    LEFT JOIN character_bible_versions v ON v.id = c.id
    WHERE c.selected_bible_version_id IS NULL AND v.id IS NULL`);
  await db.run(sql`
    UPDATE characters
    SET selected_bible_version_id = id
    WHERE selected_bible_version_id IS NULL`);
  await db.run(sql`
    UPDATE characters
    SET team_id = (SELECT s.team_id FROM sequences s WHERE s.id = characters.sequence_id)
    WHERE team_id IS NULL`);
  await db.run(sql`
    UPDATE character_bible_versions
    SET talent_id = c.talent_id
    FROM characters c
    WHERE c.selected_bible_version_id = character_bible_versions.id
      AND c.talent_id IS NOT NULL
      AND character_bible_versions.talent_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM sequence_cast x WHERE x.character_id = c.id)`);
  await db.run(sql`
    INSERT INTO sequence_cast
      (id, sequence_id, character_id, script_character_id, bible_version_id, removed_at, created_at)
    SELECT c.id, c.sequence_id, c.id, c.character_id, c.selected_bible_version_id, c.deleted_at, c.created_at
    FROM characters c
    LEFT JOIN sequence_cast x ON x.character_id = c.id
    WHERE x.id IS NULL`);
  await db.run(sql`
    INSERT INTO sequence_cast_looks
      (id, cast_id, look_id, look_version_id, selected_sheet_version_id,
       pending_promote_sheet_version_id, sheet_status, sheet_error, created_at, updated_at)
    SELECT l.id, c.id, l.id, l.selected_look_version_id, l.selected_sheet_version_id,
      l.pending_promote_sheet_version_id, l.sheet_status, l.sheet_error, l.created_at, l.updated_at
    FROM character_looks l
    JOIN sequence_cast c ON c.character_id = l.character_id
    LEFT JOIN sequence_cast_looks x ON x.look_id = l.id
    WHERE x.id IS NULL`);
  return found;
}
