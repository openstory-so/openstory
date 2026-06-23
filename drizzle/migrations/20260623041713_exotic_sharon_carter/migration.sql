ALTER TABLE `shot_prompt_variants` RENAME TO `shot_prompt_versions`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_shot_prompt_variants_shot_type_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_shot_prompt_variants_shot_type_hash_ai`;--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_versions_shot_type_created` ON `shot_prompt_versions` (`shot_id`,`prompt_type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_prompt_versions_shot_type_hash_ai` ON `shot_prompt_versions` (`shot_id`,`prompt_type`,`input_hash`) WHERE "shot_prompt_versions"."input_hash" IS NOT NULL AND "shot_prompt_versions"."source" != 'restored';