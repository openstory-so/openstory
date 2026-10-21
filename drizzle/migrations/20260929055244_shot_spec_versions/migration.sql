CREATE TABLE `shot_spec_versions` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`spec` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_shot_spec_versions_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_shot_spec_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `frame_prompt_versions` ADD `spec_version_id` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `spec_version_id` text;--> statement-breakpoint
ALTER TABLE `shots` ADD `selected_spec_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_shot_spec_versions_shot_created` ON `shot_spec_versions` (`shot_id`,`created_at`);