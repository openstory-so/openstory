CREATE TABLE `credit_reservations` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text,
	`sequence_id` text,
	`original_amount` integer NOT NULL,
	`remaining_amount` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_credit_reservations_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_credit_reservations_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT "non_negative_reservation_remaining" CHECK("remaining_amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credit_reservations_team_idempotency_key` ON `credit_reservations` (`team_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_credit_reservations_team_expires` ON `credit_reservations` (`team_id`,`expires_at`);