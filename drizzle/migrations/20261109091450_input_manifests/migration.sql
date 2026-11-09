CREATE TABLE `input_manifests` (
	`hash` text PRIMARY KEY,
	`manifest` text NOT NULL,
	`created_at` integer NOT NULL
);
