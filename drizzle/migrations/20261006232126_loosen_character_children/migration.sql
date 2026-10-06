PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_character_bible_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`personality` text,
	`movement` text,
	`voice_only` integer NOT NULL,
	`is_person` integer NOT NULL,
	`consistency_tag` text,
	`talent_id` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_bible_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`),
	CONSTRAINT `fk_character_bible_versions_talent_id_talent_id_fk` FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_character_bible_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_character_bible_versions`(`id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `talent_id`, `source`, `created_at`, `created_by`) SELECT `id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `personality`, `movement`, `voice_only`, `is_person`, `consistency_tag`, `talent_id`, `source`, `created_at`, `created_by` FROM `character_bible_versions`;--> statement-breakpoint
DROP TABLE `character_bible_versions`;--> statement-breakpoint
ALTER TABLE `__new_character_bible_versions` RENAME TO `character_bible_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_character_sheet_variants` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`look_id` text,
	`model` text(100) NOT NULL,
	`url` text,
	`storage_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`bible_version_id` text,
	`look_version_id` text,
	`diverged_at` integer,
	`discarded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_character_sheet_variants_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_character_sheet_variants`(`id`, `character_id`, `look_id`, `model`, `url`, `storage_path`, `status`, `workflow_run_id`, `generated_at`, `error`, `input_hash`, `bible_version_id`, `look_version_id`, `diverged_at`, `discarded_at`, `created_at`, `updated_at`) SELECT `id`, `character_id`, `look_id`, `model`, `url`, `storage_path`, `status`, `workflow_run_id`, `generated_at`, `error`, `input_hash`, `bible_version_id`, `look_version_id`, `diverged_at`, `discarded_at`, `created_at`, `updated_at` FROM `character_sheet_variants`;--> statement-breakpoint
DROP TABLE `character_sheet_variants`;--> statement-breakpoint
ALTER TABLE `__new_character_sheet_variants` RENAME TO `character_sheet_variants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_character_voice_versions` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`voice_id` text,
	`description` text,
	`previews` text,
	`enabled` integer,
	`source` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`workflow_run_id` text,
	`error` text,
	`released_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_character_voice_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`),
	CONSTRAINT `fk_character_voice_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_character_voice_versions`(`id`, `character_id`, `voice_id`, `description`, `previews`, `enabled`, `source`, `status`, `workflow_run_id`, `error`, `released_at`, `created_by`, `created_at`) SELECT `id`, `character_id`, `voice_id`, `description`, `previews`, `enabled`, `source`, `status`, `workflow_run_id`, `error`, `released_at`, `created_by`, `created_at` FROM `character_voice_versions`;--> statement-breakpoint
DROP TABLE `character_voice_versions`;--> statement-breakpoint
ALTER TABLE `__new_character_voice_versions` RENAME TO `character_voice_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_character_bible_versions_character_created` ON `character_bible_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_character_sheet_variants_character` ON `character_sheet_variants` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_character_sheet_variants_look` ON `character_sheet_variants` (`look_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `character_sheet_variants_look_divergent_key` ON `character_sheet_variants` (`look_id`,`model`,`input_hash`) WHERE "character_sheet_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_character_voice_versions_character_created` ON `character_voice_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_character_voice_versions_live_claim` ON `character_voice_versions` (`character_id`) WHERE "character_voice_versions"."status" IN ('pending', 'generating');