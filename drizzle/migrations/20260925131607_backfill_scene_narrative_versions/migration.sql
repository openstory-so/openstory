-- #1600 — fold each scene's narrative (title, heading, time of day, story
-- beat, continuity tags) into its `scene_script_versions` rows.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration because every deploy path only runs `wrangler d1 migrations apply`.
--
-- 1. Every existing version row takes its scene's CURRENT narrative. The
--    narrative had no history before #1600, so the current value is the only
--    one there is; copying it onto every row (not just the selected one)
--    keeps a re-selected older script from dropping it. Each filled row is
--    marked `has_narrative`; the guard is that mark, so a re-run touches only
--    rows still unmarked. A row a pre-#1600 worker writes in the deploy window
--    stays unmarked, and reads fall back to the scene's legacy columns for it.
-- 2. A scene with no script version at all (added by hand before #1600) gets
--    a first row: an empty script plus its narrative, `source = 'backfill'`.
--    THE ID IS THE SCENE'S OWN ULID (SQL cannot mint one; the #1419 rule) —
--    the same id scene split gives its seed row, and a scene with no version
--    has no seed row. `created_at` is the scene's `updated_at`.
-- 3. Point those scenes at their new row.
--
-- NO STALE FLIP ON DEPLOY. The prompt hashes read the narrative's VALUES;
-- reads now take them from the selected row, which holds exactly what the
-- scene row held. A scene with no script composed an empty script before and
-- composes the same empty script from its backfill row.
--
-- UPDATE … FROM and INSERT … SELECT are set-based (no correlated
-- subqueries, D1's remote CPU limit, #1019). No schema change here, so no
-- table rebuild and the #612 cascade trap does not apply.

UPDATE `scene_script_versions`
SET
  `title` = s.`title`,
  `location` = s.`location`,
  `time_of_day` = s.`time_of_day`,
  `story_beat` = s.`story_beat`,
  `continuity` = s.`continuity`,
  `has_narrative` = 1
FROM `scenes` s
WHERE s.`id` = `scene_script_versions`.`scene_id`
  AND `scene_script_versions`.`has_narrative` = 0;
--> statement-breakpoint
INSERT INTO `scene_script_versions` (
  `id`,
  `scene_id`,
  `content`,
  `title`,
  `location`,
  `time_of_day`,
  `story_beat`,
  `continuity`,
  `has_narrative`,
  `source`,
  `created_at`,
  `created_by`
)
SELECT
  s.`id`,
  s.`id`,
  '{"extract":"","dialogue":[]}',
  s.`title`,
  s.`location`,
  s.`time_of_day`,
  s.`story_beat`,
  s.`continuity`,
  1,
  'backfill',
  s.`updated_at`,
  NULL
FROM `scenes` s
LEFT JOIN `scene_script_versions` v ON v.`id` = s.`id`
WHERE s.`selected_script_version_id` IS NULL
  AND v.`id` IS NULL;
--> statement-breakpoint
UPDATE `scenes`
SET `selected_script_version_id` = `id`
WHERE `selected_script_version_id` IS NULL;
