ALTER TABLE `organization_billing_settings` ADD `free_sequences_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sequences` ADD `free_sketch` integer DEFAULT false NOT NULL;