DROP INDEX IF EXISTS `idx_sequences_status`;--> statement-breakpoint
CREATE INDEX `idx_character_looks_sheet_claim` ON `character_looks` (`pending_promote_sheet_version_id`,`updated_at`) WHERE "character_looks"."pending_promote_sheet_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_character_voice_versions_status_created` ON `character_voice_versions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_frame_prompt_versions_status_created` ON `frame_prompt_versions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_status_updated` ON `frame_variants` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_generated_assets_status_updated` ON `generated_assets` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sequence_elements_vision_updated` ON `sequence_elements` (`vision_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sequence_music_variants_status_created` ON `sequence_music_variants` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sequences_status_updated` ON `sequences` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_versions_status_created` ON `shot_prompt_versions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_variants_status_updated` ON `shot_variants` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_variants_shot_variant_status_updated` ON `shot_variants` (`shot_variant_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_video_variants_status_updated` ON `video_variants` (`status`,`updated_at`);