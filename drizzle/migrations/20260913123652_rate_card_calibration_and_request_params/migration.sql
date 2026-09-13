ALTER TABLE `model_pricing` ADD `rate_card_calibration` real;--> statement-breakpoint
ALTER TABLE `model_pricing` ADD `rate_card_calibration_samples` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_usage_observations` ADD `request_params` text;