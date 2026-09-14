ALTER TABLE `byteplus_assets` ADD `ark_asset_id` text;--> statement-breakpoint
ALTER TABLE `byteplus_assets` ADD `reserved_by` text;--> statement-breakpoint
ALTER TABLE `byteplus_assets` ADD `reserved_until` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_byteplus_assets_eviction`;