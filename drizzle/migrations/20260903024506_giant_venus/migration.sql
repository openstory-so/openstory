-- Table rebuild (SQLite cannot drop NOT NULL in place). Safe under the #612
-- trap: no table has an FK INTO sequence_elements, so the DROP fires no cascade.
ALTER TABLE `sequences` ADD `generation_stop_at` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `pipeline_stage` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `generation_checkpoint` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sequence_elements` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`uploaded_filename` text(500) NOT NULL,
	`token` text(100) NOT NULL,
	`description` text,
	`consistency_tag` text,
	`image_url` text,
	`image_path` text,
	`vision_status` text DEFAULT 'pending' NOT NULL,
	`vision_error` text,
	`vision_generated_at` integer,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `sequence_elements_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_sequence_elements`(`id`, `sequence_id`, `uploaded_filename`, `token`, `description`, `consistency_tag`, `image_url`, `image_path`, `vision_status`, `vision_error`, `vision_generated_at`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `deleted_at`, `created_at`, `updated_at`) SELECT `id`, `sequence_id`, `uploaded_filename`, `token`, `description`, `consistency_tag`, `image_url`, `image_path`, `vision_status`, `vision_error`, `vision_generated_at`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `deleted_at`, `created_at`, `updated_at` FROM `sequence_elements`;--> statement-breakpoint
DROP TABLE `sequence_elements`;--> statement-breakpoint
ALTER TABLE `__new_sequence_elements` RENAME TO `sequence_elements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sequence_elements_sequence_id` ON `sequence_elements` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_elements_sequence_token_key` ON `sequence_elements` (`sequence_id`,`token`);