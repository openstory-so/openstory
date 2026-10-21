-- #1695 — locations belong to the team; the location library becomes locations.
--
-- CUSTOM ON PURPOSE. The table definitions, column lists and index statements
-- are drizzle-kit's own (the snapshot beside this file is the one it wrote
-- for the generated form of the same change). What it generated could not
-- run: it added a NOT NULL `team_id` with no value, renamed the rebuilt table
-- into place, dropped `parent_type` while an index still named it, and
-- carried no data across. This file does the same schema change with the
-- data moved, in one transaction (D1 runs a migration file as one):
--
--   1. a link per existing location, reusing the location's ULID
--   2. a bible version for a location that has none; `rendering` on every one
--   3. `sequence_locations` rebuilt without its sequence columns, with the
--      team (guard-and-defer, as `20261006232156_drop_character_legacy_columns`;
--      read that file's header and AGENTS.md § D1 table-rebuild trap first)
--   4. each team library location becomes a location, its current image a
--      sheet version, its uploaded images reference photos. Ids are the
--      library rows' own ULIDs. Public templates are not carried over.
--   5. `location_sheet_variants` loses `parent_type`
--   6. `location_sheets` and `location_library` are dropped
--
-- One file and not several, so no row can be written between the backfill
-- and the rebuild: a location an older worker inserted in between would have
-- no team and no link.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
-- GUARD. Refuse to run while any table has a foreign key into
-- `sequence_locations` that ACTS on delete: with checks deferred, the drop
-- below would delete or blank those rows and commit (#612). It reads every
-- table's foreign keys, not a list of known children.
CREATE TABLE `__locations_drop_guard` (`cascades` integer NOT NULL CHECK (`cascades` = 0));--> statement-breakpoint
INSERT INTO `__locations_drop_guard` (`cascades`)
SELECT count(*)
FROM sqlite_master m, pragma_foreign_key_list(m.name) f
WHERE m.type = 'table'
  -- D1 refuses a pragma on its own `_cf_` tables (SQLITE_AUTH).
  AND m.name NOT GLOB '_cf_*'
  AND m.name NOT GLOB 'sqlite_*'
  AND lower(f."table") = 'sequence_locations'
  AND upper(f.on_delete) IN ('CASCADE', 'SET NULL', 'SET DEFAULT');--> statement-breakpoint
DROP TABLE `__locations_drop_guard`;--> statement-breakpoint
CREATE TABLE `location_reference_photos` (
	`id` text PRIMARY KEY,
	`location_id` text NOT NULL,
	`url` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_location_reference_photos_location_id_sequence_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `sequence_locations`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sequence_location_links` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`location_id` text NOT NULL,
	`script_location_id` text NOT NULL,
	`script_consistency_tag` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`removed_at` integer,
	`attached` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_location_links_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sequence_location_links_location_id_sequence_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `sequence_locations`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `location_sheet_variants` RENAME COLUMN `parent_id` TO `location_id`;--> statement-breakpoint
ALTER TABLE `location_bible_versions` ADD `rendering` text;--> statement-breakpoint
-- 1. One link per location. The old `deleted_at` (removed from its sequence)
-- becomes the link's `removed_at`; the rebuilt row's `deleted_at` means
-- deleted from the team and starts null. Analysis made every one of these
-- here, so none is `attached`.
INSERT INTO `sequence_location_links` (`id`, `sequence_id`, `location_id`, `script_location_id`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `removed_at`, `attached`, `created_at`)
SELECT l.`id`, l.`sequence_id`, l.`id`, l.`location_id`, l.`first_mention_scene_id`, l.`first_mention_text`, l.`first_mention_line`, l.`deleted_at`, 0, l.`created_at`
FROM `sequence_locations` l;--> statement-breakpoint
-- 2a. A location from before bible history (#1600) gets its version from the
-- legacy columns, under its own ULID.
INSERT INTO `location_bible_versions` (`id`, `location_id`, `name`, `type`, `description`, `architectural_style`, `key_features`, `ambiance`, `consistency_tag`, `source`, `created_at`, `created_by`)
SELECT l.`id`, l.`id`, l.`name`, l.`type`, l.`description`, l.`architectural_style`, l.`key_features`, l.`ambiance`, l.`consistency_tag`, 'backfill', l.`updated_at`, NULL
FROM `sequence_locations` l
LEFT JOIN `location_bible_versions` v ON v.`id` = l.`id`
WHERE l.`selected_bible_version_id` IS NULL AND v.`id` IS NULL;--> statement-breakpoint
-- 2b. `rendering` on every bible version, from the style of the location's
-- sequence: the same rule and the same template list as
-- `20261009063136_backfill_character_rendering`.
UPDATE `location_bible_versions` SET `rendering` = COALESCE(
  (
    SELECT COALESCE(
      NULLIF(TRIM(json_extract(ssv.`config`, '$.look.medium')), ''),
      NULLIF(TRIM(json_extract(st.`config`, '$.look.medium')), ''),
      CASE st.`name`
        WHEN 'Animatic' THEN 'Rough pencil-and-marker pre-vis sketch'
        WHEN 'Animated' THEN 'Stylized painterly animation'
        WHEN 'Bedtime Storybook' THEN 'Hand-painted storybook illustration'
        WHEN 'Saturday Morning Cartoon' THEN 'Flat 2D cartoon animation'
        WHEN 'Claymation' THEN 'Stop-motion claymation'
        WHEN 'Paper Cutout' THEN 'Stop-motion paper cutout animation'
        WHEN 'Watercolour Fable' THEN 'Watercolor illustration'
        WHEN 'Pop-Up Book' THEN 'Layered papercraft diorama'
        WHEN 'Felt and Yarn' THEN 'Stop-motion felt and yarn puppet animation'
        WHEN 'Chalkboard Doodle' THEN 'Chalk drawing on a blackboard'
        WHEN 'Lo-Fi Anime' THEN '2D cel-shaded anime'
        WHEN 'Hand-Drawn Picture Book' THEN 'Crayon and colored-pencil picture book illustration'
        WHEN 'Rough Storyboard' THEN 'Rough pencil-and-marker storyboard sketch'
        WHEN 'Low-Detail Blockout' THEN 'Untextured 3D greybox blockout'
        WHEN 'Mood-Only Frames' THEN 'Painterly still-frame painting'
        WHEN 'Black & White Previz' THEN 'Monochrome previz render'
        WHEN 'Schematic Concept' THEN 'Diagrammatic line illustration'
        WHEN 'Marker Rough' THEN 'Marker comp illustration'
        WHEN 'Greyscale Layout' THEN 'Greyscale tonal painting'
      END
    )
    FROM `sequence_locations` l
    JOIN `sequences` s ON s.`id` = l.`sequence_id`
    LEFT JOIN `sequence_style_versions` ssv ON ssv.`id` = s.`selected_style_version_id`
    LEFT JOIN `styles` st ON st.`id` = s.`style_id`
    WHERE l.`id` = `location_bible_versions`.`location_id`
  ),
  'Photoreal live action'
)
WHERE `rendering` IS NULL;--> statement-breakpoint
-- 3. The rebuild. Not drizzle's rename: copy out, drop, create the table
-- again, copy back with named columns (see the header of the character file).
-- The team is the location's sequence's. A location whose sheet was drawn
-- from a library reference keeps that reference's hash, so the digest
-- stamped on its sheet still verifies.
CREATE TABLE `__new_sequence_locations` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`selected_bible_version_id` text,
	`name` text(255) NOT NULL,
	`type` text,
	`description` text,
	`architectural_style` text,
	`key_features` text,
	`ambiance` text,
	`consistency_tag` text,
	`legacy_library_reference_hash` text,
	`reference_status` text DEFAULT 'pending' NOT NULL,
	`reference_error` text,
	`selected_reference_version_id` text,
	`pending_promote_reference_version_id` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_locations_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_sequence_locations`(`id`, `team_id`, `selected_bible_version_id`, `name`, `type`, `description`, `architectural_style`, `key_features`, `ambiance`, `consistency_tag`, `legacy_library_reference_hash`, `reference_status`, `reference_error`, `selected_reference_version_id`, `pending_promote_reference_version_id`, `deleted_at`, `created_at`, `updated_at`)
SELECT l.`id`, s.`team_id`, COALESCE(l.`selected_bible_version_id`, l.`id`), l.`name`, l.`type`, l.`description`, l.`architectural_style`, l.`key_features`, l.`ambiance`, l.`consistency_tag`, lib.`reference_input_hash`, l.`reference_status`, l.`reference_error`, l.`selected_reference_version_id`, l.`pending_promote_reference_version_id`, NULL, l.`created_at`, l.`updated_at`
FROM `sequence_locations` l
JOIN `sequences` s ON s.`id` = l.`sequence_id`
LEFT JOIN `location_library` lib ON lib.`id` = l.`library_location_id`;--> statement-breakpoint
DROP TABLE `sequence_locations`;--> statement-breakpoint
CREATE TABLE `sequence_locations` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`selected_bible_version_id` text,
	`name` text(255) NOT NULL,
	`type` text,
	`description` text,
	`architectural_style` text,
	`key_features` text,
	`ambiance` text,
	`consistency_tag` text,
	`legacy_library_reference_hash` text,
	`reference_status` text DEFAULT 'pending' NOT NULL,
	`reference_error` text,
	`selected_reference_version_id` text,
	`pending_promote_reference_version_id` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_locations_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`)
);
--> statement-breakpoint
INSERT INTO `sequence_locations`(`id`, `team_id`, `selected_bible_version_id`, `name`, `type`, `description`, `architectural_style`, `key_features`, `ambiance`, `consistency_tag`, `legacy_library_reference_hash`, `reference_status`, `reference_error`, `selected_reference_version_id`, `pending_promote_reference_version_id`, `deleted_at`, `created_at`, `updated_at`) SELECT `id`, `team_id`, `selected_bible_version_id`, `name`, `type`, `description`, `architectural_style`, `key_features`, `ambiance`, `consistency_tag`, `legacy_library_reference_hash`, `reference_status`, `reference_error`, `selected_reference_version_id`, `pending_promote_reference_version_id`, `deleted_at`, `created_at`, `updated_at` FROM `__new_sequence_locations`;--> statement-breakpoint
DROP TABLE `__new_sequence_locations`;--> statement-breakpoint
CREATE INDEX `idx_sequence_locations_team` ON `sequence_locations` (`team_id`);--> statement-breakpoint
-- 4. The team library becomes locations, each under its library row's ULID.
-- A row that is public or a template is one of the system templates and is
-- not carried over, nor are its images.
INSERT INTO `sequence_locations` (`id`, `team_id`, `selected_bible_version_id`, `name`, `reference_status`, `created_at`, `updated_at`)
SELECT lib.`id`, lib.`team_id`, lib.`id`, lib.`name`, CASE WHEN lib.`reference_image_url` IS NULL THEN 'pending' ELSE 'completed' END, lib.`created_at`, lib.`updated_at`
FROM `location_library` lib
WHERE COALESCE(lib.`is_public`, 0) = 0 AND COALESCE(lib.`is_template`, 0) = 0;--> statement-breakpoint
-- Photos are of a real place, and a library sheet was drawn with no style.
INSERT INTO `location_bible_versions` (`id`, `location_id`, `name`, `description`, `rendering`, `source`, `created_at`, `created_by`)
SELECT lib.`id`, lib.`id`, lib.`name`, lib.`description`, 'Photoreal live action', 'backfill', lib.`updated_at`, lib.`created_by`
FROM `location_library` lib
WHERE COALESCE(lib.`is_public`, 0) = 0 AND COALESCE(lib.`is_template`, 0) = 0;--> statement-breakpoint
-- The library row's current image is the location's sheet. The pointer is
-- left null: the live version of such a row is the one under its own id
-- (`20260901073039_backfill_location_sheet_variants`).
INSERT INTO `location_sheet_variants` (`id`, `parent_type`, `location_id`, `model`, `url`, `storage_path`, `status`, `generated_at`, `input_hash`, `created_at`, `updated_at`)
SELECT lib.`id`, 'library_location', lib.`id`, 'prior', lib.`reference_image_url`, lib.`reference_image_path`, 'completed', lib.`updated_at`, lib.`reference_input_hash`, lib.`updated_at`, lib.`updated_at`
FROM `location_library` lib
WHERE COALESCE(lib.`is_public`, 0) = 0 AND COALESCE(lib.`is_template`, 0) = 0
  AND lib.`reference_image_url` IS NOT NULL;--> statement-breakpoint
INSERT INTO `location_reference_photos` (`id`, `location_id`, `url`, `path`, `created_at`)
SELECT sh.`id`, sh.`location_id`, sh.`image_url`, sh.`image_path`, sh.`created_at`
FROM `location_sheets` sh
JOIN `location_library` lib ON lib.`id` = sh.`location_id`
WHERE COALESCE(lib.`is_public`, 0) = 0 AND COALESCE(lib.`is_template`, 0) = 0
  AND sh.`source` = 'manual_upload'
  AND sh.`image_url` IS NOT NULL AND sh.`image_path` IS NOT NULL;--> statement-breakpoint
-- A sheet a template's run parked has no location to belong to.
DELETE FROM `location_sheet_variants`
WHERE `parent_type` = 'library_location'
  AND `location_id` NOT IN (SELECT `id` FROM `sequence_locations`);--> statement-breakpoint
-- 5. One kind of parent now. Both indexes name `parent_type`, so they go
-- first.
DROP INDEX IF EXISTS `idx_location_sheet_variants_parent`;--> statement-breakpoint
DROP INDEX IF EXISTS `location_sheet_variants_divergent_key`;--> statement-breakpoint
ALTER TABLE `location_sheet_variants` DROP COLUMN `parent_type`;--> statement-breakpoint
CREATE INDEX `idx_location_sheet_variants_location` ON `location_sheet_variants` (`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `location_sheet_variants_divergent_key` ON `location_sheet_variants` (`location_id`,`model`,`input_hash`) WHERE "location_sheet_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_location_reference_photos_location` ON `location_reference_photos` (`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_location_links_sequence_location_key` ON `sequence_location_links` (`sequence_id`,`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_location_links_sequence_script_key` ON `sequence_location_links` (`sequence_id`,`script_location_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_location_links_location` ON `sequence_location_links` (`location_id`);--> statement-breakpoint
-- 6. The library tables. `location_sheets` first: it cascades from
-- `location_library`, and nothing else points at either once
-- `sequence_locations` has lost `library_location_id`.
DROP TABLE `location_sheets`;--> statement-breakpoint
CREATE TABLE `__location_library_drop_guard` (`children` integer NOT NULL CHECK (`children` = 0));--> statement-breakpoint
INSERT INTO `__location_library_drop_guard` (`children`)
SELECT count(*)
FROM sqlite_master m, pragma_foreign_key_list(m.name) f
WHERE m.type = 'table'
  AND m.name NOT GLOB '_cf_*'
  AND m.name NOT GLOB 'sqlite_*'
  AND lower(f."table") = 'location_library';--> statement-breakpoint
DROP TABLE `__location_library_drop_guard`;--> statement-breakpoint
DROP TABLE `location_library`;
