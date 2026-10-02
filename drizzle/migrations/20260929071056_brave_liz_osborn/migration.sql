ALTER TABLE `shot_spec_versions` ADD `input_hash` text;--> statement-breakpoint
ALTER TABLE `shots` ADD `pending_spec_version_id` text;