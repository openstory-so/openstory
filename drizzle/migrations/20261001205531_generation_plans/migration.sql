CREATE TABLE `generation_plans` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`request` text NOT NULL,
	`digest` text NOT NULL,
	`estimate_micros` integer,
	`work` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`workflow_run_id` text,
	`error` text,
	`executed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_generation_plans_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_generation_plans_sequence` ON `generation_plans` (`sequence_id`,`id`);