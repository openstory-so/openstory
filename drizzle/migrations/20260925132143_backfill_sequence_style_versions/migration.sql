-- #1600 — snapshot every sequence's style recipe as its first
-- `sequence_style_versions` row, and point the sequence at it.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration because every deploy path only runs `wrangler d1 migrations apply`.
--
-- Only sequences that HAVE a snapshot. A NULL `style_config` means an
-- automatic style still being derived (#1213) or a pre-snapshot row that
-- reads the live catalog style; both stay pointer-less, which reads exactly
-- as the NULL column did.
--
-- THE ID IS THE SEQUENCE'S OWN ULID (SQL cannot mint one; the #1419 rule),
-- which also makes a re-run insert nothing (LEFT JOIN on the primary key).
-- `created_at` is the sequence's `updated_at`: staleness causes look up the
-- snapshot live when an artifact was made, and an artifact older than this
-- finds none and falls back to naming "Style" as before.
--
-- NO STALE FLIP ON DEPLOY. The hashes read the recipe's VALUES; reads now take
-- them from the version row, which holds exactly the column's JSON.
--
-- Set-based, no correlated subqueries (D1's remote CPU limit, #1019). No
-- schema change, so no table rebuild and the #612 cascade trap does not apply.

INSERT INTO `sequence_style_versions` (
  `id`,
  `sequence_id`,
  `style_id`,
  `config`,
  `source`,
  `created_at`,
  `created_by`
)
SELECT
  s.`id`,
  s.`id`,
  s.`style_id`,
  s.`style_config`,
  'backfill',
  s.`updated_at`,
  NULL
FROM `sequences` s
LEFT JOIN `sequence_style_versions` v ON v.`id` = s.`id`
WHERE s.`style_config` IS NOT NULL
  AND v.`id` IS NULL;
--> statement-breakpoint
UPDATE `sequences`
SET `selected_style_version_id` = `id`
WHERE `selected_style_version_id` IS NULL
  AND `style_config` IS NOT NULL;
