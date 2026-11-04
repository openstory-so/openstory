-- Custom data migration (#813). Generated empty with
-- `bun db:generate --custom --name=drop_viewer_role`
-- because there is no schema diff: `role` is already text.
-- It has to be a migration rather than a script. Workers Builds, PR previews,
-- and Deploy-button clones only run `wrangler d1 migrations apply`.
--
-- The viewer role is gone. Anyone who held it becomes a member.
-- Replay-safe: a second run matches no rows.
UPDATE `member` SET `role` = 'member' WHERE `role` = 'viewer';
--> statement-breakpoint
UPDATE `team_members` SET `role` = 'member' WHERE `role` = 'viewer';
--> statement-breakpoint
UPDATE `team_invitations` SET `role` = 'member' WHERE `role` = 'viewer';
--> statement-breakpoint
UPDATE `invitation` SET `role` = 'member' WHERE `role` = 'viewer';
