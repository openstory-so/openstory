DROP INDEX IF EXISTS `idx_transactions_team_id`;--> statement-breakpoint
CREATE INDEX `idx_transactions_team_created` ON `transactions` (`team_id`,`created_at`);