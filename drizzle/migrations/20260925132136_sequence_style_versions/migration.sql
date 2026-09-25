CREATE TABLE `sequence_style_versions` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`style_id` text,
	`config` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_sequence_style_versions_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sequence_style_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `sequences` ADD `selected_style_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_sequence_style_versions_sequence_created` ON `sequence_style_versions` (`sequence_id`,`created_at`);