ALTER TABLE `character_sheet_variants` ADD `cast_look_id` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `copied_from_character_id` text;--> statement-breakpoint
ALTER TABLE `sequence_cast` ADD `voice_version_id` text;