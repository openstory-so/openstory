ALTER TABLE `sequence_music_prompt_variants` RENAME TO `sequence_music_prompt_versions`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sequence_music_prompt_variants_sequence_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_sequence_music_prompt_variants_sequence_hash_ai`;--> statement-breakpoint
CREATE INDEX `idx_sequence_music_prompt_versions_sequence_created` ON `sequence_music_prompt_versions` (`sequence_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sequence_music_prompt_versions_sequence_hash_ai` ON `sequence_music_prompt_versions` (`sequence_id`,`input_hash`) WHERE "sequence_music_prompt_versions"."input_hash" IS NOT NULL AND "sequence_music_prompt_versions"."source" != 'restored';