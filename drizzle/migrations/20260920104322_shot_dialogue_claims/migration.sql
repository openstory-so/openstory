CREATE TABLE `shot_dialogue_claims` (
	`id` text PRIMARY KEY,
	`shot_id` text NOT NULL,
	`source_key` text NOT NULL,
	`pending_source_key` text,
	`status` text NOT NULL,
	`section_id` text,
	`promoted_at` integer,
	`error` text,
	`workflow_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_shot_dialogue_claims_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_claims_shot_created` ON `shot_dialogue_claims` (`shot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_claims_status_created` ON `shot_dialogue_claims` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_dialogue_claims_live` ON `shot_dialogue_claims` (`shot_id`,`pending_source_key`) WHERE "shot_dialogue_claims"."pending_source_key" IS NOT NULL AND "shot_dialogue_claims"."status" = 'generating';