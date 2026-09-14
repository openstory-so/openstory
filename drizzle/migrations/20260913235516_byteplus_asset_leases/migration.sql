CREATE TABLE `byteplus_asset_leases` (
	`id` text PRIMARY KEY,
	`identity` text NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_byteplus_asset_leases_identity_owner` ON `byteplus_asset_leases` (`identity`,`owner`);--> statement-breakpoint
CREATE INDEX `idx_byteplus_asset_leases_owner` ON `byteplus_asset_leases` (`owner`);