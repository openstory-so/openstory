-- #1600 — snapshot every character and sequence-location bible as its first
-- `*_bible_versions` row, and point the parent at it.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`.
--
-- THE ID IS THE PARENT'S OWN ULID. SQL cannot mint a ULID, and ids only need
-- to be unique within their table, so each snapshot reuses its parent's id
-- (the #1419 rule). That also makes it replay-safe: the LEFT JOIN on the
-- primary key means a re-run inserts nothing.
--
-- `created_at` is the parent's `updated_at`: the last moment these values can
-- have been written. Staleness causes look up the version live when an
-- artifact was made; an artifact older than this finds no version and falls
-- back to naming the whole character, as before #1600, instead of claiming
-- no bible change.
--
-- NO STALE FLIP ON DEPLOY. No hash reads the pointer or the version id: the
-- sheet and prompt hashes read the bible's VALUES, and the version row copies
-- them exactly, so every recomputed hash is unchanged.
--
-- Soft-deleted parents are included; restore is meant to be lossless.
-- Set-based INSERT … SELECT and a plain UPDATE, no correlated subqueries
-- (D1's remote CPU limit, #1019). Touches no schema, so no table rebuild and
-- the #612 cascade trap does not apply.

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
WHERE v.`id` IS NULL;
--> statement-breakpoint
UPDATE `characters`
SET `selected_bible_version_id` = `id`
WHERE `selected_bible_version_id` IS NULL;
--> statement-breakpoint
INSERT INTO `location_bible_versions` (
  `id`,
  `location_id`,
  `name`,
  `type`,
  `time_of_day`,
  `description`,
  `architectural_style`,
  `key_features`,
  `color_palette`,
  `lighting_setup`,
  `ambiance`,
  `consistency_tag`,
  `source`,
  `created_at`,
  `created_by`
)
SELECT
  l.`id`,
  l.`id`,
  l.`name`,
  l.`type`,
  l.`time_of_day`,
  l.`description`,
  l.`architectural_style`,
  l.`key_features`,
  l.`color_palette`,
  l.`lighting_setup`,
  l.`ambiance`,
  l.`consistency_tag`,
  'backfill',
  l.`updated_at`,
  NULL
FROM `sequence_locations` l
LEFT JOIN `location_bible_versions` v ON v.`id` = l.`id`
WHERE v.`id` IS NULL;
--> statement-breakpoint
UPDATE `sequence_locations`
SET `selected_bible_version_id` = `id`
WHERE `selected_bible_version_id` IS NULL;
