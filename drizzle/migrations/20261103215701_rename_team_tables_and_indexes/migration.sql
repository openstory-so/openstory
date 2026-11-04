ALTER TABLE `team_api_keys` RENAME TO `organization_api_keys`;--> statement-breakpoint
ALTER TABLE `team_billing_settings` RENAME TO `organization_billing_settings`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_assistant_threads_team_user`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_audio_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_characters_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_provenance_team_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_content_reports_subject_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_credit_batches_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_credit_batches_team_remaining_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_credit_reservations_team_idempotency_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_credit_reservations_team_expires`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_enforcement_subject_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_assets_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_assets_team_endpoint`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_generated_assets_team_source`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gift_token_redemptions_token_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_gift_token_redemptions_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sequence_locations_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_teams_slug`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_team_api_keys_team_provider`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_team_api_keys_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sequences_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_stitches_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_styles_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_transactions_team_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_transactions_team_type_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_transactions_team_idempotency_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_upload_attestations_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_vfx_team_id`;--> statement-breakpoint
CREATE INDEX `idx_assistant_threads_organization_user` ON `assistant_threads` (`organization_id`,`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_audio_organization_id` ON `audio` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_characters_organization` ON `characters` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_provenance_organization_created` ON `content_provenance` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_subject_organization` ON `content_reports` (`subject_organization_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_batches_organization_id` ON `credit_batches` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_batches_organization_remaining_created` ON `credit_batches` (`organization_id`,`remaining_amount`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credit_reservations_organization_idempotency_key` ON `credit_reservations` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_credit_reservations_organization_expires` ON `credit_reservations` (`organization_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_enforcement_subject_organization` ON `enforcement_actions` (`subject_organization_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_generated_assets_organization` ON `generated_assets` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_generated_assets_organization_endpoint` ON `generated_assets` (`organization_id`,`endpoint_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_generated_assets_organization_source` ON `generated_assets` (`organization_id`,`source`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gift_token_redemptions_token_organization` ON `gift_token_redemptions` (`gift_token_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_token_redemptions_organization` ON `gift_token_redemptions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_locations_organization` ON `sequence_locations` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_slug` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_api_keys_organization_provider` ON `organization_api_keys` (`organization_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_organization_api_keys_organization_id` ON `organization_api_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_sequences_organization_id` ON `sequences` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_stitches_organization` ON `stitches` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_styles_organization_id` ON `styles` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_organization_created` ON `transactions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_transactions_organization_type_created` ON `transactions` (`organization_id`,`type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_organization_idempotency_key` ON `transactions` (`organization_id`,`idempotency_key`) WHERE "transactions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_upload_attestations_organization` ON `upload_attestations` (`organization_id`,`attested_at`);--> statement-breakpoint
CREATE INDEX `idx_vfx_organization_id` ON `vfx` (`organization_id`);