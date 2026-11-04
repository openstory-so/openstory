-- Custom data migration (#813). Generated empty with
-- `bun db:generate --custom --name=backfill_member_from_team_members`
-- because there is no schema diff: this copies rows, it does not change DDL.
-- It has to be a migration rather than a script. Workers Builds, PR previews,
-- and Deploy-button clones only run `wrangler d1 migrations apply`.
--
-- A user belongs to exactly one organization, so `member.id` reuses the user
-- id (SQL cannot mint a ULID). A second membership fails the primary key.
-- `team_members.joined_at` is unix seconds; `member.created_at` is milliseconds.
-- Replay-safe: a membership already on `member` is skipped.
INSERT INTO `member` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
SELECT `tm`.`user_id`, `tm`.`organization_id`, `tm`.`user_id`, `tm`.`role`, `tm`.`joined_at` * 1000
FROM `team_members` AS `tm`
WHERE NOT EXISTS (
	SELECT 1 FROM `member` AS `m` WHERE `m`.`user_id` = `tm`.`user_id`
);
