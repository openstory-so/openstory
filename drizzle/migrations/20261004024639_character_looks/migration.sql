CREATE TABLE `character_look_versions` (
	`id` text PRIMARY KEY,
	`look_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`clothing` text,
	`styling` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_look_versions_look_id_character_looks_id_fk` FOREIGN KEY (`look_id`) REFERENCES `character_looks`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_character_look_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `character_looks` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`is_default` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`deleted_at` integer,
	`selected_look_version_id` text NOT NULL,
	`selected_sheet_version_id` text,
	`pending_promote_sheet_version_id` text,
	`sheet_status` text NOT NULL,
	`sheet_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_character_looks_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `character_sheet_variants` ADD `look_id` text;--> statement-breakpoint
ALTER TABLE `character_sheet_variants` ADD `look_version_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `character_sheet_variants_divergent_key`;--> statement-breakpoint
CREATE INDEX `idx_character_look_versions_look_created` ON `character_look_versions` (`look_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_character_looks_character` ON `character_looks` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `character_looks_default_key` ON `character_looks` (`character_id`) WHERE "character_looks"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `idx_character_sheet_variants_look` ON `character_sheet_variants` (`look_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `character_sheet_variants_look_divergent_key` ON `character_sheet_variants` (`look_id`,`model`,`input_hash`) WHERE "character_sheet_variants"."diverged_at" IS NOT NULL;