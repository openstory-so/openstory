CREATE TABLE `gateway_jobs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text(20) NOT NULL,
	`model_key` text(100) NOT NULL,
	`input` text NOT NULL,
	`status` text(20) DEFAULT 'queued' NOT NULL,
	`via` text(50),
	`provider_job_id` text,
	`outputs` text,
	`error` text,
	`cost_micros` integer,
	`reservation_id` text,
	`workflow_run_id` text,
	`idempotency_key` text(255),
	`oauth_client_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `fk_gateway_jobs_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_gateway_jobs_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_gateway_jobs_organization` ON `gateway_jobs` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gateway_jobs_organization_idempotency` ON `gateway_jobs` (`organization_id`,`idempotency_key`);