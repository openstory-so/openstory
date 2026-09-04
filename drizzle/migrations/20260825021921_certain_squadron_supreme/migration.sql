ALTER TABLE `generated_assets` ADD `source` text(20) DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE `generated_assets` ADD `is_favorite` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_generated_assets_team_source` ON `generated_assets` (`team_id`,`source`,`id`);