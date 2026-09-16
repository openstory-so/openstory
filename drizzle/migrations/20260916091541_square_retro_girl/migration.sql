CREATE TABLE `character_voice_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`voice_id` text,
	`description` text,
	`previews` text,
	`enabled` integer,
	`source` text NOT NULL,
	`selected_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_voice_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_character_voice_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `shot_dialogue_versions` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`audio_clips` text NOT NULL,
	`input_hash` text NOT NULL,
	`workflow_run_id` text,
	`selected_at` integer,
	`discarded_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_shot_dialogue_versions_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_character_voice_versions_character_created` ON `character_voice_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_character_voice_versions_selected` ON `character_voice_versions` (`character_id`) WHERE "character_voice_versions"."selected_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_versions_shot_created` ON `shot_dialogue_versions` (`shot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_versions_shot_hash` ON `shot_dialogue_versions` (`shot_id`,`input_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_dialogue_versions_selected` ON `shot_dialogue_versions` (`shot_id`) WHERE "shot_dialogue_versions"."selected_at" IS NOT NULL;