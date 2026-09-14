ALTER TABLE `byteplus_assets` ADD `reserved_by` text;--> statement-breakpoint
ALTER TABLE `byteplus_assets` ADD `reserved_until` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_byteplus_assets` (
	`id` text PRIMARY KEY,
	`identity` text NOT NULL,
	`asset_id` text,
	`slot` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`reserved_by` text,
	`reserved_until` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_byteplus_assets`(`id`, `identity`, `asset_id`, `slot`, `last_used_at`, `created_at`) SELECT `id`, `identity`, `asset_id`, `slot`, `last_used_at`, `created_at` FROM `byteplus_assets`;--> statement-breakpoint
DROP TABLE `byteplus_assets`;--> statement-breakpoint
ALTER TABLE `__new_byteplus_assets` RENAME TO `byteplus_assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_byteplus_assets_eviction`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_byteplus_assets_identity` ON `byteplus_assets` (`identity`);