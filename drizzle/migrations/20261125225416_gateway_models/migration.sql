CREATE TABLE `gateway_models` (
	`provider` text(20) NOT NULL,
	`model_id` text(200) NOT NULL,
	`model` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT `gateway_models_pk` PRIMARY KEY(`provider`, `model_id`)
);
