CREATE TABLE `character_voice_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`voice_id` text,
	`description` text,
	`previews` text,
	`enabled` integer,
	`source` text NOT NULL,
	`released_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_character_voice_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_character_voice_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `dialogue_recordings` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`url` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`turns` text NOT NULL,
	`input_hash` text NOT NULL,
	`character_count` integer NOT NULL,
	`workflow_run_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dialogue_recordings_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE,
	CONSTRAINT "dialogue_recordings_duration" CHECK("duration_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE `shot_dialogue_sections` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`from_seconds` real NOT NULL,
	`to_seconds` real NOT NULL,
	`source_key` text NOT NULL,
	`spoken_lines` text,
	`dialogue_version_id` text,
	`source` text NOT NULL,
	`selected_at` integer,
	`discarded_at` integer,
	`workflow_run_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_shot_dialogue_sections_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE,
	CONSTRAINT "shot_dialogue_sections_range" CHECK("from_seconds" >= 0 AND "to_seconds" > "from_seconds"),
	CONSTRAINT "shot_dialogue_sections_selected_not_discarded" CHECK("discarded_at" IS NULL OR "selected_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE `shot_dialogue_versions` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`lines` text NOT NULL,
	`source` text NOT NULL,
	`selected_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_shot_dialogue_versions_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_shot_dialogue_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `selected_voice_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_character_voice_versions_character_created` ON `character_voice_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_dialogue_recordings_sequence_created` ON `dialogue_recordings` (`sequence_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_sections_shot_created` ON `shot_dialogue_sections` (`shot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_sections_recording` ON `shot_dialogue_sections` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_dialogue_sections_selected` ON `shot_dialogue_sections` (`shot_id`) WHERE "shot_dialogue_sections"."selected_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_versions_shot_created` ON `shot_dialogue_versions` (`shot_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_dialogue_versions_selected` ON `shot_dialogue_versions` (`shot_id`) WHERE "shot_dialogue_versions"."selected_at" IS NOT NULL;