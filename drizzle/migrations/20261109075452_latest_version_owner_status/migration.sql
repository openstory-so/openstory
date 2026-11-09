DROP INDEX IF EXISTS `idx_frame_variants_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sequence_music_variants_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_video_variants_sequence`;--> statement-breakpoint
CREATE INDEX `idx_frame_prompt_versions_frame_status_created` ON `frame_prompt_versions` (`frame_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_frame_kind_status` ON `frame_variants` (`frame_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_frame_status` ON `frame_variants` (`frame_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_sequence_status` ON `frame_variants` (`sequence_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sequence_music_variants_sequence_status` ON `sequence_music_variants` (`sequence_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_claims_shot_status_created` ON `shot_dialogue_claims` (`shot_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_versions_shot_type_status_created` ON `shot_prompt_versions` (`shot_id`,`prompt_type`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_video_variants_sequence_status` ON `video_variants` (`sequence_id`,`status`);