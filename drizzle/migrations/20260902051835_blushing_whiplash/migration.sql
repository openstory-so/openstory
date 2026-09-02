ALTER TABLE `frame_variants` ADD `resolution` text(10);--> statement-breakpoint
ALTER TABLE `sequences` ADD `resolution` text(10) DEFAULT '720p' NOT NULL;--> statement-breakpoint
ALTER TABLE `video_variants` ADD `resolution` text(10);