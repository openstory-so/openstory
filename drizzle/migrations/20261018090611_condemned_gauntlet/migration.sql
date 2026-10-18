-- #2135 — drop talent. Custom on purpose: drizzle-kit's rebuild of
-- `character_bible_versions` (to remove `talent_id`) is replaced here.
--
-- `talent_id` is a foreign key (`fk_character_bible_versions_talent_id_talent_id_fk`,
-- ON DELETE SET NULL). SQLite refuses `ALTER TABLE … DROP COLUMN` on a column
-- used by a foreign key (`unknown column "talent_id" in foreign key definition`).
--
-- The table definition and the column list are the post-drop snapshot. Three
-- things differ from what drizzle-kit emits (same as #2017,
-- `20261006232156_drop_character_legacy_columns`):
--
-- 1. `PRAGMA defer_foreign_keys = ON` comes first. D1 runs this file in one
--    transaction, where `PRAGMA foreign_keys=OFF` is ignored. The defer pragma
--    holds every foreign key check until that transaction commits.
-- 2. The new table is NOT renamed into place. SQLite counts a violation for
--    every child row when the parent is dropped, and only takes one off again
--    when a row is INSERTED into a table of that name. A rename inserts
--    nothing, so the count is still above zero at commit and the file rolls
--    back. So: copy out, drop, create `character_bible_versions` again, copy
--    back.
-- 3. The copy back names its columns. `INSERT … SELECT *` can take SQLite's
--    bulk-transfer path, which skips that bookkeeping.
--
-- NO child of `character_bible_versions` may be ON DELETE CASCADE, SET NULL
-- or SET DEFAULT when this runs: the pragma defers checks, not actions, so a
-- cascade would delete those rows and commit (#612). The guard below fails
-- the file unless that count is zero. The snapshot has no inbound foreign
-- keys into this table.
--
-- Talent children are dropped before `talent`, so their ON DELETE CASCADE
-- never runs. `sequences.suggested_talent_ids` is plain json, so a native
-- DROP COLUMN is enough. The face and voice copy already ran in
-- `20261018090430_copy_talent_faces_onto_characters`.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__bible_versions_drop_guard` (`cascades` integer NOT NULL CHECK (`cascades` = 0));--> statement-breakpoint
INSERT INTO `__bible_versions_drop_guard` (`cascades`)
SELECT count(*)
FROM sqlite_master m, pragma_foreign_key_list(m.name) f
WHERE m.type = 'table'
  AND m.name NOT GLOB '_cf_*'
  AND m.name NOT GLOB 'sqlite_*'
  AND lower(f."table") = 'character_bible_versions'
  AND upper(f.on_delete) IN ('CASCADE', 'SET NULL', 'SET DEFAULT');--> statement-breakpoint
DROP TABLE `__bible_versions_drop_guard`;--> statement-breakpoint
CREATE TABLE `__new_character_bible_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`personality` text,
	`movement` text,
	`voice_only` integer NOT NULL,
	`is_person` integer NOT NULL,
	`rendering` text,
	`consistency_tag` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_bible_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`),
	CONSTRAINT `fk_character_bible_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);--> statement-breakpoint
INSERT INTO `__new_character_bible_versions`(`id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `rendering`, `consistency_tag`, `source`, `created_at`, `created_by`) SELECT `id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `rendering`, `consistency_tag`, `source`, `created_at`, `created_by` FROM `character_bible_versions`;--> statement-breakpoint
DROP TABLE `character_bible_versions`;--> statement-breakpoint
CREATE TABLE `character_bible_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`personality` text,
	`movement` text,
	`voice_only` integer NOT NULL,
	`is_person` integer NOT NULL,
	`rendering` text,
	`consistency_tag` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_bible_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`),
	CONSTRAINT `fk_character_bible_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);--> statement-breakpoint
INSERT INTO `character_bible_versions`(`id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `rendering`, `consistency_tag`, `source`, `created_at`, `created_by`) SELECT `id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `rendering`, `consistency_tag`, `source`, `created_at`, `created_by` FROM `__new_character_bible_versions`;--> statement-breakpoint
DROP TABLE `__new_character_bible_versions`;--> statement-breakpoint
CREATE INDEX `idx_character_bible_versions_character_created` ON `character_bible_versions` (`character_id`,`created_at`);--> statement-breakpoint
DROP TABLE `talent_sheet_variants`;--> statement-breakpoint
DROP TABLE `talent_media`;--> statement-breakpoint
DROP TABLE `talent_sheets`;--> statement-breakpoint
DROP TABLE `talent`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `suggested_talent_ids`;
