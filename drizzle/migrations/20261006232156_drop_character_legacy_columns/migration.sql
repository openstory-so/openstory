-- #2017 — drop the legacy cast columns from `characters` and make team_id NOT NULL.
--
-- CUSTOM ON PURPOSE (`bun db:generate --custom`). The table definition, the
-- column list and the index statements are drizzle-kit's own. Three things
-- differ from what it emits:
--
-- 1. `PRAGMA defer_foreign_keys = ON` comes first. D1 runs this file in one
--    transaction, where drizzle's `PRAGMA foreign_keys=OFF` is ignored. The
--    defer pragma holds every foreign key check until that transaction
--    commits, and lasts only for it, so it has to be in this file.
-- 2. The new table is NOT renamed into place. SQLite counts a violation for
--    every child row when `characters` is dropped, and only takes one off
--    again when a row is INSERTED into a table of that name. A rename inserts
--    nothing, so the count is still above zero at commit and the whole file
--    rolls back. So: copy out, drop, create `characters` again, copy back.
-- 3. The copy back names its columns. `INSERT … SELECT *` between two
--    identical tables can take SQLite's bulk-transfer path, which skips the
--    foreign key bookkeeping in (2).
--
-- NO child of `characters` may be ON DELETE CASCADE when this runs: the
-- pragma defers checks, not actions, so a cascade would delete the child rows
-- and commit (#612). The migration before this one removes the two cascades.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
-- GUARD. Refuse to run while any table still has a foreign key into
-- `characters` that ACTS on delete (CASCADE, SET NULL, SET DEFAULT): with
-- checks deferred, the drop below would delete or blank those rows and commit
-- (#612). The count goes into a table whose CHECK only
-- accepts zero, so a cascade fails this statement and D1 rolls the file back.
-- It reads every table's foreign keys, not a list of known children.
CREATE TABLE `__characters_drop_guard` (`cascades` integer NOT NULL CHECK (`cascades` = 0));--> statement-breakpoint
INSERT INTO `__characters_drop_guard` (`cascades`)
SELECT count(*)
FROM sqlite_master m, pragma_foreign_key_list(m.name) f
WHERE m.type = 'table'
  -- D1 refuses a pragma on its own `_cf_` tables (SQLITE_AUTH).
  AND m.name NOT LIKE '\_cf\_%' ESCAPE '\'
  AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
  AND lower(f."table") = 'characters'
  AND upper(f.on_delete) IN ('CASCADE', 'SET NULL', 'SET DEFAULT');--> statement-breakpoint
DROP TABLE `__characters_drop_guard`;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`in_library` integer DEFAULT false NOT NULL,
	`selected_bible_version_id` text,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`personality` text,
	`movement` text,
	`voice_only` integer DEFAULT false NOT NULL,
	`is_person` integer DEFAULT true NOT NULL,
	`consistency_tag` text,
	`use_voice` integer,
	`selected_voice_version_id` text,
	`pending_promote_voice_version_id` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`sheet_status` text DEFAULT 'pending' NOT NULL,
	`sheet_error` text,
	`selected_sheet_version_id` text,
	`pending_promote_sheet_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_characters_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`)
);--> statement-breakpoint
INSERT INTO `__new_characters`(`id`, `team_id`, `in_library`, `selected_bible_version_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `use_voice`, `selected_voice_version_id`, `pending_promote_voice_version_id`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_status`, `sheet_error`, `selected_sheet_version_id`, `pending_promote_sheet_version_id`, `created_at`, `updated_at`) SELECT `id`, `team_id`, `in_library`, `selected_bible_version_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `use_voice`, `selected_voice_version_id`, `pending_promote_voice_version_id`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_status`, `sheet_error`, `selected_sheet_version_id`, `pending_promote_sheet_version_id`, `created_at`, `updated_at` FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`in_library` integer DEFAULT false NOT NULL,
	`selected_bible_version_id` text,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`personality` text,
	`movement` text,
	`voice_only` integer DEFAULT false NOT NULL,
	`is_person` integer DEFAULT true NOT NULL,
	`consistency_tag` text,
	`use_voice` integer,
	`selected_voice_version_id` text,
	`pending_promote_voice_version_id` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`sheet_status` text DEFAULT 'pending' NOT NULL,
	`sheet_error` text,
	`selected_sheet_version_id` text,
	`pending_promote_sheet_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_characters_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`)
);--> statement-breakpoint
INSERT INTO `characters`(`id`, `team_id`, `in_library`, `selected_bible_version_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `use_voice`, `selected_voice_version_id`, `pending_promote_voice_version_id`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_status`, `sheet_error`, `selected_sheet_version_id`, `pending_promote_sheet_version_id`, `created_at`, `updated_at`) SELECT `id`, `team_id`, `in_library`, `selected_bible_version_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `use_voice`, `selected_voice_version_id`, `pending_promote_voice_version_id`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_status`, `sheet_error`, `selected_sheet_version_id`, `pending_promote_sheet_version_id`, `created_at`, `updated_at` FROM `__new_characters`;--> statement-breakpoint
DROP TABLE `__new_characters`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_characters_sequence_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_characters_talent_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `characters_sequence_character_key`;--> statement-breakpoint
CREATE INDEX `idx_characters_team` ON `characters` (`team_id`);
