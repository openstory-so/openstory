-- #2017 — characters belong to the team, and a sequence casts them through
-- `sequence_cast` / `sequence_cast_looks`. This gives every existing
-- character its team, its one cast link and one cast look per look, and puts
-- the cast talent on the bible version the character is on.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`.
--
-- THE IDS ARE THE PARENT'S OWN ULID. SQL cannot mint a ULID, and ids only
-- need to be unique within their table: a cast link reuses its character's
-- id, a cast look reuses its look's id (the #1419 rule). That also makes it
-- replay-safe: the LEFT JOINs on the primary key mean a re-run inserts
-- nothing, and the UPDATEs only touch rows still unset.
--
-- NO STALE FLIP ON DEPLOY, NOTHING REGENERATES. Every pointer is copied
-- verbatim — the pinned bible version is the character's selected one, the
-- pinned look version is the look's selected one, and the sheet pointer,
-- status, error and an in-flight run's claim move across as they are (a NULL
-- sheet pointer stays NULL). No stored digest moves.
--
-- Soft-deleted characters are included: `deleted_at` becomes the link's
-- `removed_at`, so restore is lossless.
--
-- Nothing is dropped or rewritten in place. `characters.sequence_id`,
-- `character_id`, `talent_id`, `deleted_at` and the sheet state on
-- `character_looks` stay as they are: a worker older than this reads and
-- writes them until the deploy finishes, and the reconcile cron
-- (`sequence_cast.backfill`) repeats the inserts below for anything it wrote
-- in between.
--
-- Set-based INSERT … SELECT and UPDATE … FROM, no correlated subqueries
-- (D1's remote CPU limit, #1019). Touches no schema, so no table rebuild and
-- the #612 cascade trap does not apply.

-- A character with no bible version (one a worker older than #1600 wrote
-- during that deploy) gets one first, exactly as the #1600 backfill made
-- them, so every cast link can pin a version.
INSERT INTO `character_bible_versions` (
  `id`,
  `character_id`,
  `name`,
  `age`,
  `gender`,
  `ethnicity`,
  `physical_description`,
  `standard_clothing`,
  `distinguishing_features`,
  `personality`,
  `movement`,
  `voice_only`,
  `is_person`,
  `consistency_tag`,
  `source`,
  `created_at`,
  `created_by`
)
SELECT
  c.`id`,
  c.`id`,
  c.`name`,
  c.`age`,
  c.`gender`,
  c.`ethnicity`,
  c.`physical_description`,
  c.`standard_clothing`,
  c.`distinguishing_features`,
  c.`personality`,
  c.`movement`,
  c.`voice_only`,
  c.`is_person`,
  c.`consistency_tag`,
  'backfill',
  c.`updated_at`,
  NULL
FROM `characters` c
LEFT JOIN `character_bible_versions` v ON v.`id` = c.`id`
WHERE c.`selected_bible_version_id` IS NULL AND v.`id` IS NULL;
--> statement-breakpoint
UPDATE `characters`
SET `selected_bible_version_id` = `id`
WHERE `selected_bible_version_id` IS NULL;
--> statement-breakpoint
UPDATE `characters`
SET `team_id` = s.`team_id`
FROM `sequences` s
WHERE s.`id` = `characters`.`sequence_id`
  AND `characters`.`team_id` IS NULL;
--> statement-breakpoint
-- The cast talent goes on the version the character is on. Older versions
-- keep NULL: who played the character then was never recorded.
UPDATE `character_bible_versions`
SET `talent_id` = c.`talent_id`
FROM `characters` c
WHERE c.`selected_bible_version_id` = `character_bible_versions`.`id`
  AND c.`talent_id` IS NOT NULL
  AND `character_bible_versions`.`talent_id` IS NULL;
--> statement-breakpoint
INSERT INTO `sequence_cast` (
  `id`,
  `sequence_id`,
  `character_id`,
  `script_character_id`,
  `bible_version_id`,
  `removed_at`,
  `created_at`
)
SELECT
  c.`id`,
  c.`sequence_id`,
  c.`id`,
  c.`character_id`,
  c.`selected_bible_version_id`,
  c.`deleted_at`,
  c.`created_at`
FROM `characters` c
LEFT JOIN `sequence_cast` x ON x.`id` = c.`id`
WHERE x.`id` IS NULL;
--> statement-breakpoint
-- One cast look per look, on its character's link (whose id is the
-- character's, from the insert above).
INSERT INTO `sequence_cast_looks` (
  `id`,
  `cast_id`,
  `look_id`,
  `look_version_id`,
  `selected_sheet_version_id`,
  `pending_promote_sheet_version_id`,
  `sheet_status`,
  `sheet_error`,
  `created_at`,
  `updated_at`
)
SELECT
  l.`id`,
  l.`character_id`,
  l.`id`,
  l.`selected_look_version_id`,
  l.`selected_sheet_version_id`,
  l.`pending_promote_sheet_version_id`,
  l.`sheet_status`,
  l.`sheet_error`,
  l.`created_at`,
  l.`updated_at`
FROM `character_looks` l
LEFT JOIN `sequence_cast_looks` x ON x.`id` = l.`id`
WHERE x.`id` IS NULL;
