CREATE TABLE `frame_prompt_versions` (
	`id` text PRIMARY KEY,
	`frame_id` text NOT NULL,
	`text` text NOT NULL,
	`components` text,
	`source` text NOT NULL,
	`input_hash` text,
	`analysis_model` text(100),
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_frame_prompt_versions_frame_id_frames_id_fk` FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_frame_prompt_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `frame_variants` (
	`id` text PRIMARY KEY,
	`frame_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`kind` text DEFAULT 'model' NOT NULL,
	`model` text(100) NOT NULL,
	`source_variant_id` text,
	`url` text,
	`storage_path` text,
	`preview_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`prompt_hash` text,
	`input_hash` text,
	`discarded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_frame_variants_frame_id_frames_id_fk` FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_frame_variants_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `frames` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'first' NOT NULL,
	`source` text DEFAULT 'generated' NOT NULL,
	`image_url` text,
	`preview_image_url` text,
	`image_path` text,
	`image_status` text DEFAULT 'pending',
	`image_workflow_run_id` text,
	`image_generated_at` integer,
	`image_error` text,
	`image_model` text(100) DEFAULT 'nano_banana_2' NOT NULL,
	`image_prompt` text,
	`selected_image_version_id` text,
	`selected_image_prompt_version_id` text,
	`image_input_hash` text,
	`visual_prompt_input_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_frames_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_frames_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sequence_events` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`actor_id` text,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`summary` text,
	`data` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_events_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sequence_events_actor_id_user_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_prompt_variants_frame_type_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_frame_prompt_variants_frame_type_hash_ai`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_variants_frame_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_variants_sequence_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `frame_variants_primary_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `frame_variants_divergent_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frames_order`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frames_sequence_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `frames_sequence_id_order_index_key`;--> statement-breakpoint
CREATE INDEX `idx_frame_prompt_versions_frame_created` ON `frame_prompt_versions` (`frame_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_frame_prompt_versions_frame_hash_ai` ON `frame_prompt_versions` (`frame_id`,`input_hash`) WHERE "frame_prompt_versions"."input_hash" IS NOT NULL AND "frame_prompt_versions"."source" != 'restored';--> statement-breakpoint
CREATE INDEX `idx_frame_variants_group` ON `frame_variants` (`frame_id`,`kind`,`model`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_sequence` ON `frame_variants` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_frames_shot_order` ON `frames` (`shot_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_frames_sequence_id` ON `frames` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frames_shot_id_order_index_key` ON `frames` (`shot_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_sequence_events_sequence` ON `sequence_events` (`sequence_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_events_target` ON `sequence_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_variants_shot_type_created` ON `shot_prompt_variants` (`shot_id`,`prompt_type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_prompt_variants_shot_type_hash_ai` ON `shot_prompt_variants` (`shot_id`,`prompt_type`,`input_hash`) WHERE "shot_prompt_variants"."input_hash" IS NOT NULL AND "shot_prompt_variants"."source" != 'restored';--> statement-breakpoint
CREATE INDEX `idx_shot_variants_shot_type` ON `shot_variants` (`shot_id`,`variant_type`);--> statement-breakpoint
CREATE INDEX `idx_shot_variants_sequence_type` ON `shot_variants` (`sequence_id`,`variant_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `shot_variants_primary_key` ON `shot_variants` (`shot_id`,`variant_type`,`model`) WHERE "shot_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `shot_variants_divergent_key` ON `shot_variants` (`shot_id`,`variant_type`,`model`,`input_hash`) WHERE "shot_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shots_order` ON `shots` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_shots_sequence_id` ON `shots` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shots_sequence_id_order_index_key` ON `shots` (`sequence_id`,`order_index`);--> statement-breakpoint
ALTER TABLE `shot_variants` DROP COLUMN `shot_variant_url`;--> statement-breakpoint
ALTER TABLE `shot_variants` DROP COLUMN `shot_variant_path`;--> statement-breakpoint
ALTER TABLE `shot_variants` DROP COLUMN `shot_variant_status`;--> statement-breakpoint
ALTER TABLE `shot_variants` DROP COLUMN `shot_variant_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `preview_thumbnail_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_path`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_url`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_status`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_workflow_run_id`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_generated_at`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_error`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `image_model`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `image_prompt`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `thumbnail_input_hash`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `variant_image_input_hash`;--> statement-breakpoint
ALTER TABLE `shots` DROP COLUMN `visual_prompt_input_hash`;