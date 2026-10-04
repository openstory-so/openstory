-- #2015 — give every character its default look: the outfit its bible held
-- and the sheet state its own row held, moved onto `character_looks` /
-- `character_look_versions`, and every existing sheet keyed to that look.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`.
--
-- THE IDS ARE THE CHARACTER'S OWN ULID. SQL cannot mint a ULID, and ids only
-- need to be unique within their table, so the default look and its first
-- look version both reuse the character's id (the #1419 rule). That also
-- makes it replay-safe: the LEFT JOINs on the primary key mean a re-run
-- inserts nothing, and the UPDATE only touches rows still unkeyed.
--
-- NO STALE FLIP ON DEPLOY, NOTHING REGENERATES.
--   - The sheet hash reads the clothing's VALUE, and the look version copies
--     it exactly from the bible that was live (the selected version row, or
--     the legacy column of a character with none). `styling` is NULL, and
--     the hash adds it only when set.
--   - The shot hashes read the sheet pointer, copied verbatim — a NULL stays
--     NULL, so a character whose live sheet is the pre-#1419 row keyed to
--     its own id still resolves it the same way.
--   - Status, error and an in-flight run's claim are copied too, so a run
--     that started before the deploy lands on the look.
--
-- `created_at` of the look version is when its clothing was written: the
-- bible version's, else the character's `updated_at`.
--
-- Soft-deleted characters are included; restore is meant to be lossless.
-- The character's and the bible's old columns are left as they are: they are
-- the read fallback for a character an older worker writes mid-deploy.
-- Set-based INSERT … SELECT and a plain UPDATE, no correlated subqueries
-- (D1's remote CPU limit, #1019). Touches no schema, so no table rebuild and
-- the #612 cascade trap does not apply.

INSERT INTO `character_looks` (
  `id`,
  `character_id`,
  `is_default`,
  `sort_order`,
  `deleted_at`,
  `selected_look_version_id`,
  `selected_sheet_version_id`,
  `pending_promote_sheet_version_id`,
  `sheet_status`,
  `sheet_error`,
  `created_at`,
  `updated_at`
)
SELECT
  c.`id`,
  c.`id`,
  1,
  0,
  NULL,
  c.`id`,
  c.`selected_sheet_version_id`,
  c.`pending_promote_sheet_version_id`,
  c.`sheet_status`,
  c.`sheet_error`,
  c.`created_at`,
  c.`updated_at`
FROM `characters` c
LEFT JOIN `character_looks` l ON l.`id` = c.`id`
WHERE l.`id` IS NULL;
--> statement-breakpoint
INSERT INTO `character_look_versions` (
  `id`,
  `look_id`,
  `name`,
  `clothing`,
  `styling`,
  `source`,
  `created_at`,
  `created_by`
)
SELECT
  c.`id`,
  c.`id`,
  'Default',
  CASE
    WHEN b.`id` IS NULL THEN c.`standard_clothing`
    ELSE b.`standard_clothing`
  END,
  NULL,
  'backfill',
  COALESCE(b.`created_at`, c.`updated_at`),
  NULL
FROM `characters` c
LEFT JOIN `character_bible_versions` b ON b.`id` = c.`selected_bible_version_id`
LEFT JOIN `character_look_versions` v ON v.`id` = c.`id`
WHERE v.`id` IS NULL;
--> statement-breakpoint
UPDATE `character_sheet_variants`
SET `look_id` = `character_id`
WHERE `look_id` IS NULL;
