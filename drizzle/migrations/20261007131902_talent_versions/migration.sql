CREATE TABLE `talent_versions` (
	`id` text PRIMARY KEY,
	`talent_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`description` text,
	`is_human` integer NOT NULL,
	`sheet_id` text,
	`voice_id` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_talent_versions_talent_id_talent_id_fk` FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`),
	CONSTRAINT `fk_talent_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `character_bible_versions` ADD `talent_version_id` text;--> statement-breakpoint
ALTER TABLE `frame_prompt_versions` ADD `input_versions` text;--> statement-breakpoint
ALTER TABLE `frame_variants` ADD `input_versions` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `input_versions` text;--> statement-breakpoint
ALTER TABLE `talent` ADD `selected_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_talent_versions_talent_created` ON `talent_versions` (`talent_id`,`created_at`);