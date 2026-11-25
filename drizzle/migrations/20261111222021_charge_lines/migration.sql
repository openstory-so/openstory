CREATE TABLE `charge_lines` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`kind` text(20) NOT NULL,
	`amount_micros` integer NOT NULL,
	`payee_organization_id` text,
	`gateway_job_id` text,
	`oauth_client_id` text,
	`app_id` text,
	`sku` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_charge_lines_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_charge_lines_transaction_id_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_charge_lines_payee_organization_id_organization_id_fk` FOREIGN KEY (`payee_organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_charge_lines_gateway_job_id_gateway_jobs_id_fk` FOREIGN KEY (`gateway_job_id`) REFERENCES `gateway_jobs`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_charge_lines_transaction` ON `charge_lines` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_charge_lines_organization_client_created` ON `charge_lines` (`organization_id`,`oauth_client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_charge_lines_payee_created` ON `charge_lines` (`payee_organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_charge_lines_organization_gateway_job` ON `charge_lines` (`organization_id`,`gateway_job_id`);