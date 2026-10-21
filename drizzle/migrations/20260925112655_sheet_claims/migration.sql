ALTER TABLE `characters` ADD `pending_promote_sheet_version_id` text;--> statement-breakpoint
ALTER TABLE `location_library` ADD `pending_reference_claim_id` text;--> statement-breakpoint
ALTER TABLE `sequence_locations` ADD `pending_promote_reference_version_id` text;--> statement-breakpoint
ALTER TABLE `talent` ADD `pending_promote_sheet_id` text;