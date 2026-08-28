ALTER TABLE `characters` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `scenes` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `sequence_elements` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `sequence_locations` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `shots` ADD `deleted_at` integer;