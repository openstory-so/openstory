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
-- FACE. Where the character has no convergent sheet of its own, the current
-- bible's talent sheet (the default, else the newest non-diverged sheet
-- with an image, else the talent headshot) is copied onto a
-- `character_sheet_variants` row and the default look points at it. The
-- variant id is the character's own ULID: SQL cannot mint one, ids only
-- have to be unique within their table, and an empty #1419 snapshot
-- already lives under that id (`onConflict` is an UPDATE of that row).
-- A look with a sheet run in flight is left alone. The R2 object is not
-- duplicated; the character row keeps the same url and path.
--
-- VOICE. A talent voice is copied onto a character that has no selected
-- voice version. The version id is that bible version's ULID (one per
-- character; the character's own id is often already a voice row). A
-- character that already holds the voice is unchanged.
--
-- PERSON. A talent marked a real person keeps the current bible a person,
-- which is what the cast lock enforced. Historical versions are not
-- rewritten.
--
-- Idempotent: a character that already has a sheet or that voice is skipped.

-- The face to copy, one row per character.
CREATE TEMP TABLE `talent_face_copy` AS
SELECT
  c.`id` AS `character_id`,
  cl.`id` AS `look_id`,
  b.`id` AS `bible_version_id`,
  cl.`selected_look_version_id` AS `look_version_id`,
  COALESCE(ts.`image_url`, t.`image_url`) AS `image_url`,
  COALESCE(ts.`image_path`, t.`image_path`) AS `image_path`
FROM `characters` c
JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
JOIN `talent` t ON t.`id` = b.`talent_id`
JOIN `character_looks` cl ON cl.`character_id` = c.`id` AND cl.`is_default` = 1
LEFT JOIN `talent_sheets` ts ON ts.`id` = (
  SELECT s.`id` FROM `talent_sheets` s
  WHERE s.`talent_id` = t.`id`
    AND s.`diverged_at` IS NULL
    AND s.`image_url` IS NOT NULL
  ORDER BY s.`is_default` DESC, s.`created_at` DESC, s.`id` DESC
  LIMIT 1
)
WHERE COALESCE(ts.`image_url`, t.`image_url`) IS NOT NULL
  AND cl.`pending_promote_sheet_version_id` IS NULL
  AND cl.`sheet_status` <> 'generating'
  AND NOT EXISTS (
    SELECT 1 FROM `character_sheet_variants` v
    WHERE v.`character_id` = c.`id`
      AND v.`url` IS NOT NULL
      AND v.`discarded_at` IS NULL
      AND v.`diverged_at` IS NULL
  );

-- Fill the empty snapshot that already uses the character's id.
UPDATE `character_sheet_variants`
SET
  `look_id` = (
    SELECT f.`look_id` FROM `talent_face_copy` f
    WHERE f.`character_id` = `character_sheet_variants`.`id`
  ),
  `model` = 'prior',
  `url` = (
    SELECT f.`image_url` FROM `talent_face_copy` f
    WHERE f.`character_id` = `character_sheet_variants`.`id`
  ),
  `storage_path` = (
    SELECT f.`image_path` FROM `talent_face_copy` f
    WHERE f.`character_id` = `character_sheet_variants`.`id`
  ),
  `status` = 'completed',
  `generated_at` = cast(unixepoch('subsecond') * 1000 as integer),
  `error` = NULL,
  `bible_version_id` = (
    SELECT f.`bible_version_id` FROM `talent_face_copy` f
    WHERE f.`character_id` = `character_sheet_variants`.`id`
  ),
  `look_version_id` = (
    SELECT f.`look_version_id` FROM `talent_face_copy` f
    WHERE f.`character_id` = `character_sheet_variants`.`id`
  ),
  `diverged_at` = NULL,
  `discarded_at` = NULL,
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `id` IN (SELECT `character_id` FROM `talent_face_copy`)
  AND `url` IS NULL;

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
  f.`character_id`,
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
FROM `talent_face_copy` f
WHERE NOT EXISTS (
  SELECT 1 FROM `character_sheet_variants` v WHERE v.`id` = f.`character_id`
);

UPDATE `character_looks`
SET
  `selected_sheet_version_id` = `character_looks`.`id`,
  `sheet_status` = 'completed',
  `sheet_error` = NULL,
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `character_looks`.`is_default` = 1
  AND `character_looks`.`character_id` IN (
    SELECT `character_id` FROM `talent_face_copy`
  )
  AND EXISTS (
    SELECT 1 FROM `character_sheet_variants` v
    WHERE v.`id` = `character_looks`.`id` AND v.`url` IS NOT NULL
  )
  AND (
    `character_looks`.`selected_sheet_version_id` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `character_sheet_variants` v
      WHERE v.`id` = `character_looks`.`selected_sheet_version_id`
        AND v.`url` IS NOT NULL
        AND v.`discarded_at` IS NULL
        AND v.`diverged_at` IS NULL
    )
  );

-- A talent voice the character does not already hold.
CREATE TEMP TABLE `talent_voice_copy` AS
SELECT
  c.`id` AS `character_id`,
  b.`id` AS `version_id`,
  t.`voice_id` AS `voice_id`,
  t.`voice_description` AS `voice_description`
FROM `characters` c
JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
JOIN `talent` t ON t.`id` = b.`talent_id`
WHERE c.`selected_voice_version_id` IS NULL
  AND t.`voice_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `character_voice_versions` v
    WHERE v.`character_id` = c.`id`
      AND v.`voice_id` = t.`voice_id`
      AND v.`released_at` IS NULL
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
FROM `talent_voice_copy` f
WHERE NOT EXISTS (
  SELECT 1 FROM `character_voice_versions` v WHERE v.`id` = f.`version_id`
);

UPDATE `characters`
SET
  `selected_voice_version_id` = (
    SELECT f.`version_id` FROM `talent_voice_copy` f
    WHERE f.`character_id` = `characters`.`id`
  ),
  `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `id` IN (SELECT `character_id` FROM `talent_voice_copy`)
  AND `selected_voice_version_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `character_voice_versions` v
    JOIN `talent_voice_copy` f ON f.`version_id` = v.`id`
    WHERE f.`character_id` = `characters`.`id`
  );

UPDATE `character_bible_versions`
SET `is_person` = 1
WHERE `id` IN (
  SELECT c.`selected_bible_version_id`
  FROM `characters` c
  JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
  JOIN `talent` t ON t.`id` = b.`talent_id`
  WHERE t.`is_human` = 1 AND b.`is_person` = 0
);

DROP TABLE `talent_face_copy`;
DROP TABLE `talent_voice_copy`;
