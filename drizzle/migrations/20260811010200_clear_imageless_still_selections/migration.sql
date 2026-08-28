-- #1133 — stop 58 frames claiming a finished still that has no image.
--
-- `frames.selected_image_version_id` points at a `frame_variants` row whose
-- `url` is NULL, while `frames.image_status` says 'completed'. So the frame
-- reports a finished still and renders nothing. All 58 in production are the
-- same shape: kind 'model', model 'flux_2_turbo', status 'completed', no url
-- and no storage_path — husks that #989 step 4b pointed the selection at when
-- it synthesised a primary version per shot.
--
-- `frameVariants.select` refuses a non-'completed' row, which is why this was
-- never caught: these ARE marked completed, they just never produced bytes.
-- They also predate that guard.
--
-- WHAT THIS SETS, and why not something cleverer:
--   * selected_image_version_id → NULL. Repointing at a good version was
--     considered and is impossible here: 0 of the 58 frames own any completed
--     url-bearing 'model'/'framing' version. There is nothing to choose, and
--     choosing on the user's behalf is not a migration's job anyway.
--   * image_status → 'pending'. The honest state for "no still yet", and the
--     same value `ImageWorkflow` settles to when a run finishes without
--     becoming the selection (see the settleStatus branch). NOT 'generating',
--     which would spin forever, and not 'failed', which would claim an error
--     that never happened.
--
-- All 58 frames do own a completed preview with a url, so once the selection
-- is cleared they fall back to the pre-prompt stand-in — which is exactly what
-- a frame with no still is supposed to show (#1101).
--
-- Verified against openstory-prd, re-checked immediately before this landed:
-- still 58 rows, all still claiming 'completed', 0 carrying a live
-- `pending_promote_version_id`, and 0 dangling selection pointers, 0 selections
-- of a discarded version and 0 selections of a preview. Those frames were last
-- touched between 2026-05-28 and 2026-06-18, so nothing is repairing them on
-- its own.
--
-- The predicate is "selected version has no url", not "is flux_2_turbo": that
-- is the honest definition of the corruption and it catches any future
-- instance rather than the one model that happens to produce it today.
--
-- Set-based UPDATE … FROM (join), not a correlated subquery — those trip D1's
-- remote CPU limit and migrations apply BEFORE deploy (#1019). Idempotent:
-- after this runs no selection points at a url-less row, so a re-run matches 0.
-- Touches no schema, so there is no table rebuild and #612 does not apply.

UPDATE `frames`
SET `selected_image_version_id` = NULL,
    `image_status` = 'pending',
    `updated_at` = CAST(strftime('%s', 'now') AS INTEGER)
FROM (
  SELECT f.`id` AS `frame_id`
  FROM `frames` f
  JOIN `frame_variants` fv ON fv.`id` = f.`selected_image_version_id`
  WHERE fv.`url` IS NULL
) m
WHERE `frames`.`id` = m.`frame_id`;
