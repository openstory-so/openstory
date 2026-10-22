-- Custom data migration (#2135): a character's face, sheet and voice stay
-- on the character when talent goes away.
--
-- HAND-WRITTEN ON PURPOSE. This has no schema diff, so drizzle-kit cannot
-- emit it (`bun db:generate --custom`). It has to be a migration rather than
-- a script because every deploy path runs `wrangler d1 migrations apply`.
-- The next migration drops `talent`, `talent_sheets`, `talent_media`,
-- `talent_sheet_variants`, and the `talent_id` pointers. This file runs
-- first, while those rows still exist. It touches no schema, so there is
-- no table rebuild and the #612 cascade trap does not apply.
--
-- D1-SAFE SHAPE. D1 refuses TEMP tables (SQLITE_AUTH), so the scratch
-- tables are ordinary `__` tables dropped at the end. Every write is
-- set-based (`UPDATE … FROM`, LEFT JOIN anti-joins, ROW_NUMBER picks): no
-- correlated subquery, which trips D1's remote CPU limit (#1019).
--
-- IDS. SQL cannot mint a ULID, so each new row reuses a ULID this character
-- already owns that the table does not hold yet: the character id (also the
-- id of its first bible version, default look, look version, voice version
-- and #1419 sheet snapshot), then the current bible version id, then the
-- default look's version id. Old characters often have none free.
--
-- FACE. Where the character has no convergent sheet of its own, the current
-- bible's talent sheet (the default, else the newest non-diverged sheet
-- with an image, else the talent headshot) is copied onto a
-- `character_sheet_variants` row and the default look points at it. An
-- empty snapshot under the character id is filled in place. A discarded or
-- diverged sheet under that id is kept when another id is free, and
-- overwritten when none is. A look with a sheet run in flight is left
-- alone. The R2 object is not duplicated; the character row keeps the same
-- url and path.
--
-- VOICE. A talent voice is copied onto a character that has no selected
-- voice version, under a free id, else over a released or failed voice row
-- of that character. A character with neither stops the file through a
-- guard: overwriting a live row would strand its provider slot. A
-- character that already holds the voice is unchanged.
--
-- PERSON. A talent marked a real person keeps the current bible a person,
-- which is what the cast lock enforced. Historical versions are not
-- rewritten.
--
-- Idempotent: a character that already has a sheet or that voice is skipped.

-- The face to copy, one row per character.
CREATE TABLE `__talent_face_copy` AS
WITH `best_sheet` AS (
  SELECT
    s.`talent_id`,
    s.`image_url`,
    s.`image_path`,
    ROW_NUMBER() OVER (
      PARTITION BY s.`talent_id`
      ORDER BY s.`is_default` DESC, s.`created_at` DESC, s.`id` DESC
    ) AS `rn`
  FROM `talent_sheets` s
  WHERE s.`diverged_at` IS NULL AND s.`image_url` IS NOT NULL
),
`live_sheet` AS (
  SELECT DISTINCT `character_id` FROM `character_sheet_variants`
  WHERE `url` IS NOT NULL
    AND `discarded_at` IS NULL
    AND `diverged_at` IS NULL
)
SELECT
  c.`id` AS `character_id`,
  cl.`id` AS `look_id`,
  b.`id` AS `bible_version_id`,
  cl.`selected_look_version_id` AS `look_version_id`,
  CASE
    WHEN vc.`url` IS NULL THEN c.`id`
    WHEN vb.`id` IS NULL THEN b.`id`
    WHEN vl.`id` IS NULL THEN cl.`selected_look_version_id`
    -- No free id: the character's own sheet row takes the face. It is dead,
    -- since the copy only runs for a character with no live sheet.
    ELSE c.`id`
  END AS `variant_id`,
  COALESCE(bs.`image_url`, t.`image_url`) AS `image_url`,
  COALESCE(bs.`image_path`, t.`image_path`) AS `image_path`
FROM `characters` c
JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
JOIN `talent` t ON t.`id` = b.`talent_id`
JOIN `character_looks` cl ON cl.`character_id` = c.`id` AND cl.`is_default` = 1
LEFT JOIN `best_sheet` bs ON bs.`talent_id` = t.`id` AND bs.`rn` = 1
LEFT JOIN `live_sheet` ls ON ls.`character_id` = c.`id`
LEFT JOIN `character_sheet_variants` vc ON vc.`id` = c.`id`
LEFT JOIN `character_sheet_variants` vb ON vb.`id` = b.`id`
LEFT JOIN `character_sheet_variants` vl
  ON vl.`id` = cl.`selected_look_version_id`
WHERE COALESCE(bs.`image_url`, t.`image_url`) IS NOT NULL
  AND cl.`pending_promote_sheet_version_id` IS NULL
  AND cl.`sheet_status` <> 'generating'
  AND ls.`character_id` IS NULL;

-- Two characters on one id would merge their faces: stop the file instead.
CREATE TABLE `__talent_face_copy_guard` (
  `clashes` integer NOT NULL CHECK (`clashes` = 0)
);
INSERT INTO `__talent_face_copy_guard` (`clashes`)
SELECT count(*) - count(DISTINCT `variant_id`) FROM `__talent_face_copy`;
DROP TABLE `__talent_face_copy_guard`;

-- Fill the row under the character's id: an empty snapshot, or a dead
-- sheet when no other id was free.
UPDATE `character_sheet_variants`
SET
  `look_id` = f.`look_id`,
  `model` = 'prior',
  `url` = f.`image_url`,
  `storage_path` = f.`image_path`,
  `status` = 'completed',
  `generated_at` = cast(unixepoch('subsecond') * 1000 as integer),
  `error` = NULL,
  `portrait_url` = NULL,
  `input_hash` = CASE
    WHEN `character_sheet_variants`.`url` IS NULL
    THEN `character_sheet_variants`.`input_hash`
  END,
  `bible_version_id` = f.`bible_version_id`,
  `look_version_id` = f.`look_version_id`,
  `diverged_at` = NULL,
  `discarded_at` = NULL,
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
FROM `__talent_face_copy` f
WHERE `character_sheet_variants`.`id` = f.`variant_id`
  AND `character_sheet_variants`.`character_id` = f.`character_id`
  AND (
    `character_sheet_variants`.`url` IS NULL
    OR `character_sheet_variants`.`discarded_at` IS NOT NULL
    OR `character_sheet_variants`.`diverged_at` IS NOT NULL
  );

INSERT INTO `character_sheet_variants` (
  `id`,
  `character_id`,
  `look_id`,
  `model`,
  `url`,
  `storage_path`,
  `status`,
  `generated_at`,
  `bible_version_id`,
  `look_version_id`,
  `created_at`,
  `updated_at`
)
SELECT
  f.`variant_id`,
  f.`character_id`,
  f.`look_id`,
  'prior',
  f.`image_url`,
  f.`image_path`,
  'completed',
  cast(unixepoch('subsecond') * 1000 as integer),
  f.`bible_version_id`,
  f.`look_version_id`,
  cast(unixepoch('subsecond') * 1000 as integer),
  cast(unixepoch('subsecond') * 1000 as integer)
FROM `__talent_face_copy` f
LEFT JOIN `character_sheet_variants` v ON v.`id` = f.`variant_id`
WHERE v.`id` IS NULL;

-- Point the default look at the face, only where it landed live.
UPDATE `character_looks`
SET
  `selected_sheet_version_id` = f.`variant_id`,
  `sheet_status` = 'completed',
  `sheet_error` = NULL,
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
FROM `__talent_face_copy` f
JOIN `character_sheet_variants` v
  ON v.`id` = f.`variant_id`
  AND v.`character_id` = f.`character_id`
  AND v.`url` IS NOT NULL
  AND v.`discarded_at` IS NULL
  AND v.`diverged_at` IS NULL
WHERE `character_looks`.`id` = f.`look_id`;

-- A talent voice the character does not already hold.
CREATE TABLE `__talent_voice_copy` AS
WITH `held` AS (
  SELECT DISTINCT `character_id`, `voice_id` FROM `character_voice_versions`
  WHERE `released_at` IS NULL AND `voice_id` IS NOT NULL
),
`dead` AS (
  SELECT
    `character_id`,
    `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `character_id` ORDER BY `created_at`, `id`
    ) AS `rn`
  FROM `character_voice_versions`
  WHERE `released_at` IS NOT NULL OR `status` = 'failed'
)
SELECT
  c.`id` AS `character_id`,
  CASE
    WHEN vb.`id` IS NULL THEN b.`id`
    WHEN vc.`id` IS NULL THEN c.`id`
    WHEN cl.`selected_look_version_id` IS NOT NULL AND vl.`id` IS NULL
      THEN cl.`selected_look_version_id`
    ELSE d.`id`
  END AS `version_id`,
  t.`voice_id` AS `voice_id`,
  t.`voice_description` AS `voice_description`
FROM `characters` c
JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
JOIN `talent` t ON t.`id` = b.`talent_id`
LEFT JOIN `character_looks` cl
  ON cl.`character_id` = c.`id` AND cl.`is_default` = 1
LEFT JOIN `character_voice_versions` vb ON vb.`id` = b.`id`
LEFT JOIN `character_voice_versions` vc ON vc.`id` = c.`id`
LEFT JOIN `character_voice_versions` vl
  ON vl.`id` = cl.`selected_look_version_id`
LEFT JOIN `dead` d ON d.`character_id` = c.`id` AND d.`rn` = 1
LEFT JOIN `held` h ON h.`character_id` = c.`id` AND h.`voice_id` = t.`voice_id`
WHERE c.`selected_voice_version_id` IS NULL
  AND t.`voice_id` IS NOT NULL
  AND h.`character_id` IS NULL;

-- A voice with no free or dead row, or two characters on one id, stops
-- the file.
CREATE TABLE `__talent_voice_copy_guard` (
  `unplaced` integer NOT NULL CHECK (`unplaced` = 0)
);
INSERT INTO `__talent_voice_copy_guard` (`unplaced`)
SELECT count(*) - count(DISTINCT `version_id`) FROM `__talent_voice_copy`;
DROP TABLE `__talent_voice_copy_guard`;

-- Reuse a dead voice row when no other id was free.
UPDATE `character_voice_versions`
SET
  `voice_id` = f.`voice_id`,
  `description` = f.`voice_description`,
  `previews` = NULL,
  `enabled` = 1,
  `source` = 'library',
  `status` = 'completed',
  `workflow_run_id` = NULL,
  `error` = NULL,
  `released_at` = NULL
FROM `__talent_voice_copy` f
WHERE `character_voice_versions`.`id` = f.`version_id`
  AND `character_voice_versions`.`character_id` = f.`character_id`
  AND (
    `character_voice_versions`.`released_at` IS NOT NULL
    OR `character_voice_versions`.`status` = 'failed'
  );

INSERT INTO `character_voice_versions` (
  `id`,
  `character_id`,
  `voice_id`,
  `description`,
  `enabled`,
  `source`,
  `status`,
  `created_at`
)
SELECT
  f.`version_id`,
  f.`character_id`,
  f.`voice_id`,
  f.`voice_description`,
  1,
  'library',
  'completed',
  cast(unixepoch('subsecond') * 1000 as integer)
FROM `__talent_voice_copy` f
LEFT JOIN `character_voice_versions` v ON v.`id` = f.`version_id`
WHERE v.`id` IS NULL;

-- Select the voice, only where it landed on this character, live.
UPDATE `characters`
SET
  `selected_voice_version_id` = f.`version_id`,
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
FROM `__talent_voice_copy` f
JOIN `character_voice_versions` v
  ON v.`id` = f.`version_id`
  AND v.`character_id` = f.`character_id`
  AND v.`voice_id` = f.`voice_id`
  AND v.`released_at` IS NULL
WHERE `characters`.`id` = f.`character_id`
  AND `characters`.`selected_voice_version_id` IS NULL;

UPDATE `character_bible_versions`
SET `is_person` = 1
FROM `characters` c
JOIN `talent` t ON t.`is_human` = 1
WHERE c.`selected_bible_version_id` = `character_bible_versions`.`id`
  AND t.`id` = `character_bible_versions`.`talent_id`
  AND `character_bible_versions`.`is_person` = 0;

DROP TABLE `__talent_face_copy`;
DROP TABLE `__talent_voice_copy`;
