ALTER TABLE `scene_script_versions` ADD `title` text;--> statement-breakpoint
ALTER TABLE `scene_script_versions` ADD `location` text;--> statement-breakpoint
ALTER TABLE `scene_script_versions` ADD `time_of_day` text;--> statement-breakpoint
ALTER TABLE `scene_script_versions` ADD `story_beat` text;--> statement-breakpoint
ALTER TABLE `scene_script_versions` ADD `continuity` text;--> statement-breakpoint
ALTER TABLE `scene_script_versions` ADD `has_narrative` integer DEFAULT false NOT NULL;