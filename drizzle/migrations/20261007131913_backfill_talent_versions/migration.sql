-- #1862 — talent gets a history; every cast records the talent version it was made from.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`. The table and the two columns it fills were
-- added by the generated migration just before it (one CREATE TABLE, five
-- ADD COLUMNs, no rebuild).
--
-- THE IDS ARE THE PARENT'S OWN ULID. SQL cannot mint a ULID, and ids only
-- need to be unique within their table: a talent's first version takes the
-- talent's id, exactly as a character's first bible version took the
-- character's (#1600). That makes it replay-safe: the INSERT is guarded by a
-- LEFT JOIN on the primary key and every UPDATE touches only rows still
-- unset. It also makes the cast edge a one-liner: a bible version cast with
-- talent T was cast from T's backfill version, whose id is T.
--
-- NOTHING IS DELETED, NOTHING REGENERATES: no hash reads these columns.
--
-- Set-based INSERT … SELECT and UPDATE … FROM, no correlated subqueries
-- (D1's remote CPU limit, #1019). Touches no schema, so no table rebuild and
-- the #612 cascade trap does not apply.

-- 1. One version per talent, as the row stands: the version's time is the
--    row's last edit, so a version appended later sorts after it.
INSERT INTO `talent_versions` (
  `id`, `talent_id`, `name`, `description`, `is_human`, `sheet_id`, `voice_id`,
  `source`, `created_at`, `created_by`
)
SELECT
  t.`id`, t.`id`, t.`name`, t.`description`, coalesce(t.`is_human`, 0),
  t.`selected_sheet_id`, t.`voice_id`, 'backfill', t.`updated_at`, t.`created_by`
FROM `talent` t
LEFT JOIN `talent_versions` v ON v.`id` = t.`id`
WHERE v.`id` IS NULL;
--> statement-breakpoint
-- 2. The talent's current version is that one.
UPDATE `talent`
SET `selected_version_id` = `id`
WHERE `selected_version_id` IS NULL;
--> statement-breakpoint
-- 3. Every cast made before talent history was made from the talent as it
--    stood, which is its backfill version (id = the talent's id). A version
--    whose talent is gone (the FK set it null) stays null: unknown, not
--    guessed.
UPDATE `character_bible_versions`
SET `talent_version_id` = `talent_id`
WHERE `talent_id` IS NOT NULL
  AND `talent_version_id` IS NULL;
