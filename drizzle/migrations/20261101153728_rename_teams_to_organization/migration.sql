ALTER TABLE `teams` RENAME TO `organization`;--> statement-breakpoint
ALTER TABLE `assistant_threads` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `audio` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `characters` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `content_provenance` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `content_reports` RENAME COLUMN `subject_team_id` TO `subject_organization_id`;--> statement-breakpoint
ALTER TABLE `credit_batches` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `credit_reservations` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `credits` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `enforcement_actions` RENAME COLUMN `subject_team_id` TO `subject_organization_id`;--> statement-breakpoint
ALTER TABLE `generated_assets` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `gift_token_redemptions` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `sequence_locations` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `sequences` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `stitches` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `styles` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `team_api_keys` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `team_billing_settings` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `team_invitations` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `team_members` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `transactions` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `upload_attestations` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `vfx` RENAME COLUMN `team_id` TO `organization_id`;--> statement-breakpoint
ALTER TABLE `welcome_card_claims` RENAME COLUMN `team_id` TO `organization_id`;