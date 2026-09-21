ALTER TABLE `characters` ADD `voice_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `voice_error` text;