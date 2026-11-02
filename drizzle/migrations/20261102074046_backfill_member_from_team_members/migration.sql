-- Custom data migration (#813). Generated empty with
-- `bun db:generate --custom --name=backfill_member_from_team_members`
-- because there is no schema diff: this copies rows, it does not change DDL.
-- It has to be a migration rather than a script. Workers Builds, PR previews,
-- and Deploy-button clones only run `wrangler d1 migrations apply`.
--
-- `member.id` is its own primary key. SQL cannot mint a ULID, so a user with
-- exactly one `team_members` row reuses that user id. A user in more than one
-- organization is left for the app, which mints an id on the next request.
-- `team_members.joined_at` is unix seconds; `member.created_at` is milliseconds.
-- Replay-safe: a membership already on `member` is skipped.
INSERT INTO `member` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
SELECT `tm`.`user_id`, `tm`.`organization_id`, `tm`.`user_id`, `tm`.`role`, `tm`.`joined_at` * 1000
FROM `team_members` AS `tm`
WHERE `tm`.`user_id` IN (
	SELECT `user_id` FROM `team_members` GROUP BY `user_id` HAVING COUNT(*) = 1
)
AND NOT EXISTS (
	SELECT 1 FROM `member` AS `m`
	WHERE `m`.`organization_id` = `tm`.`organization_id` AND `m`.`user_id` = `tm`.`user_id`
);
