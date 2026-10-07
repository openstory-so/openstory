-- #2018 — talent becomes a likeness: one reference sheet, no role data.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`. The two columns it fills were added by the
-- generated migration just before it (two `ADD COLUMN`s, no rebuild).
--
-- THE IDS ARE THE PARENT'S OWN ULID. SQL cannot mint a ULID, and ids only
-- need to be unique within their table (the #1419 rule): a sheet copied out
-- of `talent_sheet_variants` keeps the variant's id; a talent split into a
-- library character gives that character, its bible version, its voice
-- version, its default look, that look's version and its default sheet the
-- TALENT'S id, and every other look, look version and sheet the SHEET'S id.
-- That makes it replay-safe: every INSERT is guarded by a LEFT JOIN on the
-- primary key, every UPDATE touches only rows still unset.
--
-- NOTHING IS DELETED. NO STALE FLIP ON DEPLOY, NOTHING REGENERATES: the
-- reference sheet is the row that was the Default (or the newest convergent
-- one), which is what `resolveCastTalent` already read, so the character
-- sheet hash reads the same `input_hash` and image. The old columns
-- (`personality`, `movement`, `voice_description`, `talent_sheets.name`,
-- `is_default`) are left as they are: a worker older than this reads them
-- until the deploy finishes. They are dropped in a later PR.
--
-- What each existing talent becomes:
--   * Stock talent (`is_public = 1`): a likeness. Its Default sheet is the
--     reference sheet.
--   * Talent that "Add to Library" made from a character — a sheet with
--     source `script_analysis`, or a personality, movement or designed voice
--     on the row (a hand-typed one counts too; one rule) — becomes a LIBRARY
--     CHARACTER carrying the name, face, personality, movement and designed
--     voice, with each convergent sheet as a look (the reference sheet as the
--     default look) and each sheet as that look's completed sheet, PLUS the
--     talent itself as a likeness, which the character's bible version names
--     as its cast talent. The character is in no sequence (no cast link); a
--     sequence that casts it later reads its default look's sheet by the
--     #1419 rule (`character_sheet_variants.id = characters.id`).
--   * Every other team talent: a likeness. Its Default sheet is the
--     reference sheet; any other convergent sheet stays in its history,
--     discarded but restorable.
--   * Every live `talent_sheet_variants` row under a convergent sheet (a
--     parked alternate) becomes a `talent_sheets` row of its own, parked or
--     discarded as it was. A variant under a parked sheet duplicates that
--     sheet (the double-store, #2018) and is not copied.
--
-- Set-based INSERT … SELECT and UPDATE … FROM, no correlated subqueries
-- (D1's remote CPU limit, #1019). Touches no schema, so no table rebuild and
-- the #612 cascade trap does not apply.

-- 1. The reference sheet: the Default convergent sheet, …
UPDATE `talent`
SET `selected_sheet_id` = d.`id`
FROM (
  SELECT `talent_id`, min(`id`) AS `id`
  FROM `talent_sheets`
  WHERE `is_default` = 1 AND `diverged_at` IS NULL
  GROUP BY `talent_id`
) d
WHERE d.`talent_id` = `talent`.`id`
  AND `talent`.`selected_sheet_id` IS NULL;
--> statement-breakpoint
-- … else the newest convergent one (what the "any sheet" fallback showed).
UPDATE `talent`
SET `selected_sheet_id` = n.`id`
FROM (
  SELECT s.`talent_id`, max(s.`id`) AS `id`
  FROM `talent_sheets` s
  JOIN (
    SELECT `talent_id`, max(`created_at`) AS `created_at`
    FROM `talent_sheets`
    WHERE `diverged_at` IS NULL
    GROUP BY `talent_id`
  ) m ON m.`talent_id` = s.`talent_id` AND m.`created_at` = s.`created_at`
  WHERE s.`diverged_at` IS NULL
  GROUP BY s.`talent_id`
) n
WHERE n.`talent_id` = `talent`.`id`
  AND `talent`.`selected_sheet_id` IS NULL;
--> statement-breakpoint

-- 2. Parked alternates move into the sheet history under their own id.
INSERT INTO `talent_sheets` (
  `id`, `talent_id`, `name`, `image_url`, `image_path`, `metadata`,
  `is_default`, `source`, `input_hash`, `diverged_at`, `discarded_at`,
  `created_at`, `updated_at`
)
SELECT
  v.`id`, p.`talent_id`, p.`name`, v.`url`, v.`storage_path`, p.`metadata`,
  0, 'ai_generated', v.`input_hash`, v.`diverged_at`, v.`discarded_at`,
  v.`created_at`, v.`updated_at`
FROM `talent_sheet_variants` v
JOIN `talent_sheets` p ON p.`id` = v.`talent_sheet_id`
LEFT JOIN `talent_sheets` x ON x.`id` = v.`id`
WHERE x.`id` IS NULL
  AND v.`diverged_at` IS NOT NULL
  AND v.`url` IS NOT NULL
  AND p.`diverged_at` IS NULL;
--> statement-breakpoint

-- 3. Every other convergent sheet is history: discarded, restorable.
UPDATE `talent_sheets`
SET `discarded_at` = CAST(strftime('%s', 'now') AS INTEGER),
    `updated_at` = CAST(strftime('%s', 'now') AS INTEGER)
FROM `talent` t
WHERE t.`id` = `talent_sheets`.`talent_id`
  AND t.`selected_sheet_id` IS NOT NULL
  AND `talent_sheets`.`id` <> t.`selected_sheet_id`
  AND `talent_sheets`.`diverged_at` IS NULL
  AND `talent_sheets`.`discarded_at` IS NULL;
--> statement-breakpoint

-- 4. Talent carrying role data splits off a library character.
--    "split" below is: not stock, and a personality, movement or voice on
--    the row, or a sheet copied from a character (`script_analysis`).
--    Replay: the role columns are left in place, so the set is stable; each
--    insert's LEFT JOIN on its own id makes a re-run a no-op.
INSERT INTO `characters` (
  `id`, `team_id`, `in_library`, `selected_bible_version_id`, `name`,
  `voice_only`, `is_person`, `sheet_status`, `created_at`, `updated_at`
)
SELECT
  t.`id`, t.`team_id`, 1, t.`id`, t.`name`,
  0, t.`is_human`, 'completed', t.`created_at`, t.`updated_at`
FROM `talent` t
LEFT JOIN (
  SELECT `talent_id` FROM `talent_sheets`
  WHERE `source` = 'script_analysis' GROUP BY `talent_id`
) sa ON sa.`talent_id` = t.`id`
LEFT JOIN `characters` c ON c.`id` = t.`id`
WHERE c.`id` IS NULL
  AND t.`is_public` = 0
  AND (
    t.`personality` IS NOT NULL OR t.`movement` IS NOT NULL
    OR t.`voice_id` IS NOT NULL OR sa.`talent_id` IS NOT NULL
  );
--> statement-breakpoint
-- 4a. Its bible version: the face from the reference sheet's metadata, the
--     role from the talent row, cast with the talent itself.
INSERT INTO `character_bible_versions` (
  `id`, `character_id`, `name`, `age`, `gender`, `ethnicity`,
  `physical_description`, `standard_clothing`, `distinguishing_features`,
  `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`,
  `talent_id`, `source`, `created_at`, `created_by`
)
SELECT
  t.`id`, t.`id`, t.`name`,
  json_extract(s.`metadata`, '$.age'),
  json_extract(s.`metadata`, '$.gender'),
  json_extract(s.`metadata`, '$.ethnicity'),
  COALESCE(json_extract(s.`metadata`, '$.physicalDescription'), t.`description`),
  json_extract(s.`metadata`, '$.standardClothing'),
  json_extract(s.`metadata`, '$.distinguishingFeatures'),
  t.`personality`, t.`movement`, 0, t.`is_human`,
  json_extract(s.`metadata`, '$.consistencyTag'),
  t.`id`, 'backfill', t.`updated_at`, t.`created_by`
FROM `characters` c
JOIN `talent` t ON t.`id` = c.`id`
LEFT JOIN `talent_sheets` s ON s.`id` = t.`selected_sheet_id`
LEFT JOIN `character_bible_versions` v ON v.`id` = t.`id`
WHERE v.`id` IS NULL;
--> statement-breakpoint
-- 4b. The designed voice moves onto the character as its selected voice
--     version, and leaves the talent (which holds only a recorded voice,
--     #1631), so the slot is counted once.
INSERT INTO `character_voice_versions` (
  `id`, `character_id`, `voice_id`, `description`, `enabled`,
  `source`, `status`, `created_at`, `created_by`
)
SELECT
  t.`id`, t.`id`, t.`voice_id`, t.`voice_description`, 1,
  'library', 'completed', t.`updated_at`, t.`created_by`
FROM `characters` c
JOIN `talent` t ON t.`id` = c.`id`
LEFT JOIN `character_voice_versions` v ON v.`id` = t.`id`
WHERE v.`id` IS NULL AND t.`voice_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `characters`
SET `selected_voice_version_id` = v.`id`
FROM `character_voice_versions` v
WHERE v.`id` = `characters`.`id`
  AND v.`character_id` = `characters`.`id`
  AND `characters`.`selected_voice_version_id` IS NULL;
--> statement-breakpoint
UPDATE `talent`
SET `voice_id` = NULL
FROM `character_voice_versions` v
WHERE v.`id` = `talent`.`id`
  AND v.`character_id` = `talent`.`id`
  AND v.`voice_id` = `talent`.`voice_id`;
--> statement-breakpoint
-- 4c. One look per convergent sheet. The reference sheet's look is the
--     default and takes the character's id; the others take their sheet's.
INSERT INTO `character_looks` (
  `id`, `character_id`, `is_default`, `sort_order`,
  `selected_look_version_id`, `sheet_status`, `created_at`, `updated_at`
)
SELECT
  k.`look_id`, k.`character_id`, k.`is_default`, k.`sort_order`,
  k.`look_id`, 'completed', k.`created_at`, k.`updated_at`
FROM (
  SELECT
    CASE WHEN s.`id` = t.`selected_sheet_id` THEN t.`id` ELSE s.`id` END AS `look_id`,
    t.`id` AS `character_id`,
    CASE WHEN s.`id` = t.`selected_sheet_id` THEN 1 ELSE 0 END AS `is_default`,
    row_number() OVER (
      PARTITION BY t.`id`
      ORDER BY (s.`id` = t.`selected_sheet_id`) DESC, s.`created_at`, s.`id`
    ) - 1 AS `sort_order`,
    s.`created_at`, s.`updated_at`
  FROM `characters` c
  JOIN `talent` t ON t.`id` = c.`id`
  JOIN `talent_sheets` s ON s.`talent_id` = t.`id` AND s.`diverged_at` IS NULL
) k
LEFT JOIN `character_looks` l ON l.`id` = k.`look_id`
WHERE l.`id` IS NULL;
--> statement-breakpoint
INSERT INTO `character_look_versions` (
  `id`, `look_id`, `name`, `clothing`, `styling`, `source`, `created_at`, `created_by`
)
SELECT
  l.`id`, l.`id`,
  CASE WHEN l.`is_default` = 1 THEN 'Default' ELSE s.`name` END,
  json_extract(s.`metadata`, '$.standardClothing'),
  NULL, 'backfill', s.`created_at`, NULL
FROM `character_looks` l
JOIN `talent` t ON t.`id` = l.`character_id`
JOIN `talent_sheets` s
  ON s.`id` = CASE WHEN l.`is_default` = 1 THEN t.`selected_sheet_id` ELSE l.`id` END
LEFT JOIN `character_look_versions` v ON v.`id` = l.`id`
WHERE v.`id` IS NULL;
--> statement-breakpoint
-- 4d. Each sheet is its look's completed sheet. The default look's sheet
--     takes the character's id (the #1419 rule: a default look with no
--     pointer reads the sheet row keyed to its character). `model` is the
--     upload sentinel (`USER_UPLOAD_MODEL`): the image came in as it is.
INSERT INTO `character_sheet_variants` (
  `id`, `character_id`, `look_id`, `model`, `url`, `storage_path`, `status`,
  `generated_at`, `input_hash`, `bible_version_id`, `look_version_id`,
  `created_at`, `updated_at`
)
SELECT
  l.`id`, l.`character_id`, l.`id`, 'user-upload', s.`image_url`, s.`image_path`,
  'completed', s.`created_at`, NULL, l.`character_id`, l.`id`,
  s.`created_at`, s.`updated_at`
FROM `character_looks` l
JOIN `talent` t ON t.`id` = l.`character_id`
JOIN `talent_sheets` s
  ON s.`id` = CASE WHEN l.`is_default` = 1 THEN t.`selected_sheet_id` ELSE l.`id` END
LEFT JOIN `character_sheet_variants` x ON x.`id` = l.`id`
WHERE x.`id` IS NULL;
