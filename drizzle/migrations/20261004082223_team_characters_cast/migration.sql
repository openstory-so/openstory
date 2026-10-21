CREATE TABLE `sequence_cast` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`character_id` text NOT NULL,
	`script_character_id` text NOT NULL,
	`bible_version_id` text NOT NULL,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_cast_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sequence_cast_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sequence_cast_looks` (
	`id` text PRIMARY KEY,
	`cast_id` text NOT NULL,
	`look_id` text NOT NULL,
	`look_version_id` text NOT NULL,
	`selected_sheet_version_id` text,
	`pending_promote_sheet_version_id` text,
	`sheet_status` text NOT NULL,
	`sheet_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_cast_looks_cast_id_sequence_cast_id_fk` FOREIGN KEY (`cast_id`) REFERENCES `sequence_cast`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sequence_cast_looks_look_id_character_looks_id_fk` FOREIGN KEY (`look_id`) REFERENCES `character_looks`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `character_bible_versions` ADD `talent_id` text REFERENCES talent(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `team_id` text REFERENCES teams(id);--> statement-breakpoint
ALTER TABLE `characters` ADD `in_library` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_characters_team` ON `characters` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_cast_sequence_character_key` ON `sequence_cast` (`sequence_id`,`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_cast_sequence_script_character_key` ON `sequence_cast` (`sequence_id`,`script_character_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_cast_character` ON `sequence_cast` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_cast_looks_cast_look_key` ON `sequence_cast_looks` (`cast_id`,`look_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_cast_looks_look` ON `sequence_cast_looks` (`look_id`);