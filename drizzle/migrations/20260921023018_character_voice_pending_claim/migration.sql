ALTER TABLE `character_voice_versions` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `character_voice_versions` ADD `workflow_run_id` text;--> statement-breakpoint
ALTER TABLE `character_voice_versions` ADD `error` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `pending_promote_voice_version_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_character_voice_versions_live_claim` ON `character_voice_versions` (`character_id`) WHERE "character_voice_versions"."status" IN ('pending', 'generating');