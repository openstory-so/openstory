ALTER TABLE `generated_assets` ADD `draft_task_id` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `draft_motion` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `video_variants` ADD `draft_task_id` text;