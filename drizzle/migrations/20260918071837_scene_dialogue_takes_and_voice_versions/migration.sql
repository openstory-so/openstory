CREATE TABLE `character_voice_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`voice_id` text,
	`description` text,
	`previews` text,
	`enabled` integer,
	`source` text NOT NULL,
	`selected_at` integer,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_voice_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_character_voice_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `scene_dialogue_takes` (
	`id` text PRIMARY KEY,
	`scene_id` text NOT NULL,
	`dialogue_version_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`url` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`segments` text NOT NULL,
	`clips` text NOT NULL,
	`character_count` integer NOT NULL,
	`workflow_run_id` text,
	`selected_at` integer,
	`discarded_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_scene_dialogue_takes_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `scene_dialogue_versions` (
	`id` text PRIMARY KEY,
	`scene_id` text NOT NULL,
	`lines` text NOT NULL,
	`source` text NOT NULL,
	`selected_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_scene_dialogue_versions_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scene_dialogue_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `selected_voice_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_character_voice_versions_character_created` ON `character_voice_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_character_voice_versions_selected` ON `character_voice_versions` (`character_id`) WHERE "character_voice_versions"."selected_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scene_dialogue_takes_scene_created` ON `scene_dialogue_takes` (`scene_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scene_dialogue_takes_scene_hash` ON `scene_dialogue_takes` (`scene_id`,`input_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scene_dialogue_takes_selected` ON `scene_dialogue_takes` (`scene_id`) WHERE "scene_dialogue_takes"."selected_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scene_dialogue_versions_scene_created` ON `scene_dialogue_versions` (`scene_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scene_dialogue_versions_selected` ON `scene_dialogue_versions` (`scene_id`) WHERE "scene_dialogue_versions"."selected_at" IS NOT NULL;