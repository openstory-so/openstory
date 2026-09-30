-- #1942 — a frame's image status and error move from the `frames` copy
-- (`image_status` / `image_error` / `image_workflow_run_id`, dropped by the
-- next migration) to the newest `frame_variants` row with `is_primary = 1`
-- (preview rows excluded). With no speaking row a frame reads `completed` when
-- it has a selected still, else `pending`.
--
-- HAND-WRITTEN ON PURPOSE: a data backfill has no schema diff, so drizzle-kit
-- cannot emit it (generated with `bun db:generate --custom`). It is a
-- migration because every deploy path only runs `wrangler d1 migrations apply`.
--
-- 1. Every existing row leaves the race: the frame copy, not the rows, was
--    the status until now, and most old rows (added models, runs the copy
--    already settled) never spoke for it.
-- 2. The run the copy names speaks again when the copy says it is in flight
--    or failed and that run's newest non-preview row agrees. Its error takes
--    the frame's message, which is what the shot showed.
-- 3. A failed frame with no such row (the run died before opening one) gets a
--    failed primary row. THE ID IS THE FRAME'S OWN ULID (SQL cannot mint one;
--    the #1419 rule), which also makes a re-run insert nothing. The model is
--    the selected still's, else the default image model.
--
-- A frame the copy calls `generating` with no open row reads from its
-- selection instead: nothing is rendering for it.
--
-- Set-based, no correlated subqueries (D1's remote CPU limit, #1019). No
-- schema change, so no table rebuild and the #612 cascade trap does not apply.

UPDATE `frame_variants` SET `is_primary` = 0;
--> statement-breakpoint
UPDATE `frame_variants`
SET `is_primary` = 1,
    `error` = CASE WHEN `run`.`image_status` = 'failed' THEN `run`.`image_error` ELSE `frame_variants`.`error` END
FROM (
  SELECT max(`fv`.`id`) AS `id`, `f`.`image_status`, `f`.`image_error`
  FROM `frames` `f`
  JOIN `frame_variants` `fv`
    ON `fv`.`frame_id` = `f`.`id`
   AND `fv`.`workflow_run_id` = `f`.`image_workflow_run_id`
  WHERE `fv`.`kind` != 'preview'
    AND (
      (`f`.`image_status` = 'generating' AND `fv`.`status` IN ('pending', 'generating'))
      OR (`f`.`image_status` = 'failed' AND `fv`.`status` = 'failed')
    )
  GROUP BY `f`.`id`
) AS `run`
WHERE `frame_variants`.`id` = `run`.`id`;
--> statement-breakpoint
INSERT INTO `frame_variants` (
  `id`,
  `frame_id`,
  `sequence_id`,
  `kind`,
  `model`,
  `status`,
  `error`,
  `workflow_run_id`,
  `is_primary`,
  `created_at`,
  `updated_at`
)
SELECT
  `f`.`id`,
  `f`.`id`,
  `f`.`sequence_id`,
  'model',
  coalesce(`sel`.`model`, 'gpt_image_2'),
  'failed',
  `f`.`image_error`,
  `f`.`image_workflow_run_id`,
  1,
  `f`.`updated_at`,
  `f`.`updated_at`
FROM `frames` `f`
LEFT JOIN `frame_variants` `sel` ON `sel`.`id` = `f`.`selected_image_version_id`
LEFT JOIN `frame_variants` `spoken` ON `spoken`.`frame_id` = `f`.`id` AND `spoken`.`is_primary` = 1
LEFT JOIN `frame_variants` `dup` ON `dup`.`id` = `f`.`id`
WHERE `f`.`image_status` = 'failed'
  AND `spoken`.`id` IS NULL
  AND `dup`.`id` IS NULL;
