ALTER TABLE `characters` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sequence_locations` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sequences` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `styles` ADD `slug` text DEFAULT '' NOT NULL;