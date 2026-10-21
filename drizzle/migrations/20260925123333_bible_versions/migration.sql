CREATE TABLE `character_bible_versions` (
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
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_character_bible_versions_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_character_bible_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `location_bible_versions` (
	`id` text PRIMARY KEY,
	`location_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`type` text,
	`time_of_day` text,
	`description` text,
	`architectural_style` text,
	`key_features` text,
	`color_palette` text,
	`lighting_setup` text,
	`ambiance` text,
	`consistency_tag` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_location_bible_versions_location_id_sequence_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `sequence_locations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_location_bible_versions_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `character_sheet_variants` ADD `bible_version_id` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `selected_bible_version_id` text;--> statement-breakpoint
ALTER TABLE `location_sheet_variants` ADD `bible_version_id` text;--> statement-breakpoint
ALTER TABLE `sequence_locations` ADD `selected_bible_version_id` text;--> statement-breakpoint
CREATE INDEX `idx_character_bible_versions_character_created` ON `character_bible_versions` (`character_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_location_bible_versions_location_created` ON `location_bible_versions` (`location_id`,`created_at`);