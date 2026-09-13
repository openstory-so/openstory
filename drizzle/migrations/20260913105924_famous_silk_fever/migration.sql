ALTER TABLE `model_pricing` ADD `rate_card` text;--> statement-breakpoint
ALTER TABLE `model_pricing` ADD `rate_card_source_hash` text(64);--> statement-breakpoint
ALTER TABLE `model_pricing` ADD `rate_card_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `model_pricing` ADD `rate_card_expires_at` integer;