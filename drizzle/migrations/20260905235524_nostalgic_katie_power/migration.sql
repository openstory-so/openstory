CREATE TABLE `byteplus_assets` (
	`id` text PRIMARY KEY,
	`identity` text NOT NULL,
	`asset_id` text NOT NULL,
	`slot` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_byteplus_assets_identity` ON `byteplus_assets` (`identity`);--> statement-breakpoint
CREATE INDEX `idx_byteplus_assets_eviction` ON `byteplus_assets` (`lease_expires_at`,`last_used_at`);