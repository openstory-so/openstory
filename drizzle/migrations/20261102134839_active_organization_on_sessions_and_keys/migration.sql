-- Custom data migration (#813). Generated empty with
-- `bun db:generate --custom --name=active_organization_on_sessions_and_keys`.
-- There is no fallback organization any more: a session acts for its
-- `active_organization_id` and an `osk_` key for the `organizationId` in its
-- `metadata`. Rows made before #813 have neither. Every user has exactly one
-- membership at this point, so that membership is the answer.
UPDATE `session`
SET `active_organization_id` = `m`.`organization_id`
FROM `member` AS `m`
WHERE `m`.`user_id` = `session`.`user_id`
AND `session`.`active_organization_id` IS NULL;
--> statement-breakpoint
UPDATE `apikey`
SET `metadata` = json_set(coalesce(`apikey`.`metadata`, '{}'), '$.organizationId', `m`.`organization_id`)
FROM `member` AS `m`
WHERE `m`.`user_id` = `apikey`.`reference_id`
AND json_extract(coalesce(`apikey`.`metadata`, '{}'), '$.organizationId') IS NULL;
