ALTER TABLE `upload_attestations` ADD `carried_from_id` text;--> statement-breakpoint
ALTER TABLE `upload_attestations` ADD `carried_by_user_id` text REFERENCES user(id) ON DELETE RESTRICT;