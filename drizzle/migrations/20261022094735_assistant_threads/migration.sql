CREATE TABLE `assistant_interrupts` (
	`id` text PRIMARY KEY,
	`interrupt_id` text NOT NULL,
	`run_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` integer NOT NULL,
	`resolved_at` integer,
	`payload` text NOT NULL,
	`response` text,
	CONSTRAINT `fk_assistant_interrupts_thread_id_assistant_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `assistant_threads`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `assistant_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`message` text NOT NULL,
	CONSTRAINT `fk_assistant_messages_thread_id_assistant_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `assistant_threads`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `assistant_runs` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`error_code` text,
	`usage` text,
	`sandbox_key` text,
	`detached_since` integer,
	`cancel_requested` integer,
	`driver_epoch` integer,
	`parent_run_id` text,
	`subagent_run_id` text,
	`name` text,
	CONSTRAINT `fk_assistant_runs_thread_id_assistant_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `assistant_threads`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `assistant_threads` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_assistant_threads_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_assistant_threads_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_assistant_interrupts_interrupt` ON `assistant_interrupts` (`interrupt_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_interrupts_thread_requested` ON `assistant_interrupts` (`thread_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_interrupts_run_requested` ON `assistant_interrupts` (`run_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_assistant_messages_thread_message` ON `assistant_messages` (`thread_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_messages_thread_position` ON `assistant_messages` (`thread_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_assistant_runs_run` ON `assistant_runs` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_thread_started` ON `assistant_runs` (`thread_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_parent_started` ON `assistant_runs` (`parent_run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_threads_team_user` ON `assistant_threads` (`team_id`,`user_id`,`updated_at`);