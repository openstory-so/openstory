ALTER TABLE `styles` ADD `sequence_id` text;--> statement-breakpoint
CREATE INDEX `idx_styles_sequence_id` ON `styles` (`sequence_id`);