CREATE TABLE `gateway_apps` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`name` text(100) NOT NULL,
	`status` text(20) DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_gateway_apps_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `gateway_grants` (
	`id` text PRIMARY KEY,
	`oauth_client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`monthly_cap_micros` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_gateway_grants_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `credit_reservations` ADD `oauth_client_id` text;--> statement-breakpoint
ALTER TABLE `credit_reservations` ADD `app_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_apps_oauth_client` ON `gateway_apps` (`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_apps_organization` ON `gateway_apps` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_grants_client_user_organization` ON `gateway_grants` (`oauth_client_id`,`user_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_grants_user` ON `gateway_grants` (`user_id`);