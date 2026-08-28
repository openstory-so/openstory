CREATE TABLE `content_provenance` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text,
	`asset_kind` text(40) NOT NULL,
	`asset_id` text NOT NULL,
	`storage_key` text(500),
	`content_sha256` text(64),
	`provider` text(50) NOT NULL,
	`model` text(200) NOT NULL,
	`provider_request_id` text(200),
	`workflow_run_id` text(200),
	`prompt_sha256` text(64),
	`sequence_id` text,
	`shot_id` text,
	`used_reference_images` integer DEFAULT false NOT NULL,
	`reference_image_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_content_provenance_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_content_provenance_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY,
	`reporter_user_id` text,
	`reporter_email` text(320),
	`target_type` text(40) NOT NULL,
	`target_id` text(1000) NOT NULL,
	`trace_id` text,
	`subject_team_id` text,
	`subject_user_id` text,
	`reason` text(40) NOT NULL,
	`details` text(5000),
	`status` text(20) DEFAULT 'open' NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`handled_by_user_id` text,
	`handled_at` integer,
	`resolution_notes` text(5000),
	`ip_address` text(45),
	`user_agent` text(500),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_content_reports_reporter_user_id_user_id_fk` FOREIGN KEY (`reporter_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_content_reports_subject_team_id_teams_id_fk` FOREIGN KEY (`subject_team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_content_reports_subject_user_id_user_id_fk` FOREIGN KEY (`subject_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_content_reports_handled_by_user_id_user_id_fk` FOREIGN KEY (`handled_by_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `enforcement_actions` (
	`id` text PRIMARY KEY,
	`subject_user_id` text,
	`subject_team_id` text,
	`action` text(40) NOT NULL,
	`reason` text(40) NOT NULL,
	`notes` text(5000),
	`report_id` text,
	`actor_user_id` text,
	`applied_by_system` text(100),
	`effective_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`revoked_reason` text(500),
	`notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_enforcement_actions_subject_user_id_user_id_fk` FOREIGN KEY (`subject_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_enforcement_actions_subject_team_id_teams_id_fk` FOREIGN KEY (`subject_team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_enforcement_actions_report_id_content_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `content_reports`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_enforcement_actions_actor_user_id_user_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_enforcement_actions_revoked_by_user_id_user_id_fk` FOREIGN KEY (`revoked_by_user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `upload_attestations` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`subject_type` text(40) NOT NULL,
	`subject_id` text NOT NULL,
	`statement_version` text(60) NOT NULL,
	`statement_sha256` text(64) NOT NULL,
	`depicts_real_person` integer DEFAULT false NOT NULL,
	`authorization_basis` text(500),
	`ip_address` text(45),
	`user_agent` text(500),
	`attested_at` integer NOT NULL,
	CONSTRAINT `fk_upload_attestations_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_upload_attestations_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `idx_provenance_storage_key` ON `content_provenance` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_provenance_content_sha` ON `content_provenance` (`content_sha256`);--> statement-breakpoint
CREATE INDEX `idx_provenance_team_created` ON `content_provenance` (`team_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_provenance_user_created` ON `content_provenance` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_provenance_provider_request` ON `content_provenance` (`provider_request_id`);--> statement-breakpoint
CREATE INDEX `idx_provenance_asset` ON `content_provenance` (`asset_kind`,`asset_id`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_status_priority` ON `content_reports` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_subject_team` ON `content_reports` (`subject_team_id`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_subject_user` ON `content_reports` (`subject_user_id`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_target` ON `content_reports` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_content_reports_trace` ON `content_reports` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_enforcement_subject_user` ON `enforcement_actions` (`subject_user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_enforcement_subject_team` ON `enforcement_actions` (`subject_team_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_enforcement_created` ON `enforcement_actions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_enforcement_report` ON `enforcement_actions` (`report_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_attestations_subject` ON `upload_attestations` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_attestations_user` ON `upload_attestations` (`user_id`,`attested_at`);--> statement-breakpoint
CREATE INDEX `idx_upload_attestations_team` ON `upload_attestations` (`team_id`,`attested_at`);