CREATE TABLE `gateway_app_skus` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`key` text(64) NOT NULL,
	`name` text(100) NOT NULL,
	`price_micros` integer NOT NULL,
	`status` text(20) DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_gateway_app_skus_app_id_gateway_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `gateway_apps`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `gateway_earnings` (
	`id` text PRIMARY KEY,
	`charge_line_id` text NOT NULL,
	`payer_organization_id` text NOT NULL,
	`payee_organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`status` text(20) DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`matured_at` integer,
	`transaction_id` text,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_gateway_earnings_charge_line_id_charge_lines_id_fk` FOREIGN KEY (`charge_line_id`) REFERENCES `charge_lines`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_gateway_earnings_payer_organization_id_organization_id_fk` FOREIGN KEY (`payer_organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_gateway_earnings_payee_organization_id_organization_id_fk` FOREIGN KEY (`payee_organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_gateway_earnings_app_id_gateway_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `gateway_apps`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_gateway_earnings_transaction_id_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `gateway_apps` ADD `margin_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_grants` ADD `accepted_margin_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_grants` ADD `accepted_sku_prices` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_gateway_jobs_organization_idempotency`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_app_skus_app_key` ON `gateway_app_skus` (`app_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_earnings_charge_line` ON `gateway_earnings` (`charge_line_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_earnings_status_available` ON `gateway_earnings` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_gateway_earnings_payee_app_created` ON `gateway_earnings` (`payee_organization_id`,`app_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_jobs_organization_client_idempotency` ON `gateway_jobs` (`organization_id`,coalesce("oauth_client_id", ''),`idempotency_key`);