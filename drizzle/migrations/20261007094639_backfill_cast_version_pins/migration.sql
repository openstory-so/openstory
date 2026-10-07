-- #2017 (PR 3, version moves) — a cast link pins a voice version, and a
-- sheet row says which cast look it was drawn for.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration, not a script, because every deploy path only runs
-- `wrangler d1 migrations apply`. The two columns it fills were added by the
-- generated migration just before it (two `ADD COLUMN`s, no rebuild).
--
-- NO ID IS MINTED. Both columns are pointers at rows that already exist, so
-- nothing here needs a ULID.
--
-- NO STALE FLIP ON DEPLOY, NOTHING REGENERATES. No hash reads either column.
--
-- Replay-safe: each UPDATE touches only rows still unset.
--
-- Set-based UPDATE … FROM, no correlated subqueries (D1's remote CPU limit,
-- #1019). Touches no schema, so no table rebuild and the #612 cascade trap
-- does not apply.

-- 1. Every cast link pins the voice version its character is on now. Before
--    this column the voice was read off the character, so this is exactly
--    what each sequence heard. A character with no voice keeps NULL: that is
--    "no voice", not "unknown".
UPDATE `sequence_cast`
SET `voice_version_id` = c.`selected_voice_version_id`
FROM `characters` c
WHERE c.`id` = `sequence_cast`.`character_id`
  AND `sequence_cast`.`voice_version_id` IS NULL
  AND c.`selected_voice_version_id` IS NOT NULL;
--> statement-breakpoint

-- 2. A sheet row names the cast look it was drawn for when that is knowable:
--    the look (a row with no `look_id` is a sheet of its character's default
--    look, whose id is the character's, the #1419 rule) has exactly ONE cast
--    look, so every sheet of it was drawn for that sequence. A look cast in
--    two sequences already (#2050's attach) leaves its rows NULL — unknown —
--    and those are listed for every sequence, as every row was before.
UPDATE `character_sheet_variants`
SET `cast_look_id` = one.`cast_look_id`
FROM (
  SELECT `look_id`, min(`id`) AS `cast_look_id`
  FROM `sequence_cast_looks`
  GROUP BY `look_id`
  HAVING count(*) = 1
) one
WHERE one.`look_id` = COALESCE(`character_sheet_variants`.`look_id`, `character_sheet_variants`.`character_id`)
  AND `character_sheet_variants`.`cast_look_id` IS NULL;
