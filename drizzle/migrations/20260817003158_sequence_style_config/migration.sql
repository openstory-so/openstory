ALTER TABLE `sequences` ADD `style_config` text;--> statement-breakpoint
-- Copy the live catalog recipe onto every sequence that still points at a style.
-- Set-based UPDATE … FROM so this is one join, not a per-row subquery (#1019).
-- Idempotent: re-running matches 0 rows once style_config is populated.
UPDATE `sequences`
SET `style_config` = `src`.`config`
FROM (
	SELECT `s`.`id` AS `sequence_id`, `st`.`config` AS `config`
	FROM `sequences` `s`
	INNER JOIN `styles` `st` ON `st`.`id` = `s`.`style_id`
	WHERE `s`.`style_config` IS NULL
) AS `src`
WHERE `sequences`.`id` = `src`.`sequence_id`;