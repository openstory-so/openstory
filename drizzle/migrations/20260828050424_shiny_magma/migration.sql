ALTER TABLE `characters` ADD `selected_sheet_version_id` text;--> statement-breakpoint
ALTER TABLE `sequence_locations` ADD `selected_reference_version_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `character_sheet_variants_primary_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `location_sheet_variants_primary_key`;