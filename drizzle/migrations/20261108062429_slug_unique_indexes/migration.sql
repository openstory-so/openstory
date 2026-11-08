CREATE UNIQUE INDEX `idx_characters_organization_slug` ON `characters` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sequence_locations_organization_slug` ON `sequence_locations` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sequences_organization_slug` ON `sequences` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_styles_organization_slug` ON `styles` (`organization_id`,`slug`);