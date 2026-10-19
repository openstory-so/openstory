CREATE TABLE `stitches` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cut` text NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	CONSTRAINT `fk_stitches_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_stitches_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_stitches_team` ON `stitches` (`team_id`);