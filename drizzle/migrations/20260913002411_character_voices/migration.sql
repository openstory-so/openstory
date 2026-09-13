ALTER TABLE `characters` ADD `voice_id` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `voice_description` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `voice_previews` text;--> statement-breakpoint
ALTER TABLE `characters` ADD `use_voice` integer;--> statement-breakpoint
ALTER TABLE `sequences` ADD `generate_voices` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `talent` ADD `voice_id` text;--> statement-breakpoint
ALTER TABLE `talent` ADD `voice_description` text;