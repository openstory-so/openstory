-- Custom data migration (#2017): a look's sheet pointer, claim and status go
-- back onto `character_looks`, shared by every sequence that uses the look.
-- `sequence_cast_looks` held one copy per sequence; where two sequences
-- selected different sheets of one look, the most recently updated cast look
-- wins, a cast look that selected a sheet winning over one that did not.
-- The next migration drops `sequence_cast_looks`. Hand-written because it is
-- a pure data backfill, which drizzle-kit cannot emit.
UPDATE `character_looks` SET
  `selected_sheet_version_id` = (
    SELECT scl.`selected_sheet_version_id` FROM `sequence_cast_looks` scl
    WHERE scl.`look_id` = `character_looks`.`id` AND scl.`selected_sheet_version_id` IS NOT NULL
    ORDER BY scl.`updated_at` DESC, scl.`id` DESC LIMIT 1
  ),
  `pending_promote_sheet_version_id` = (
    SELECT scl.`pending_promote_sheet_version_id` FROM `sequence_cast_looks` scl
    WHERE scl.`look_id` = `character_looks`.`id` AND scl.`pending_promote_sheet_version_id` IS NOT NULL
    ORDER BY scl.`updated_at` DESC, scl.`id` DESC LIMIT 1
  ),
  `sheet_status` = (
    SELECT scl.`sheet_status` FROM `sequence_cast_looks` scl
    WHERE scl.`look_id` = `character_looks`.`id`
    ORDER BY (scl.`selected_sheet_version_id` IS NOT NULL) DESC, scl.`updated_at` DESC, scl.`id` DESC LIMIT 1
  ),
  `sheet_error` = (
    SELECT scl.`sheet_error` FROM `sequence_cast_looks` scl
    WHERE scl.`look_id` = `character_looks`.`id`
    ORDER BY (scl.`selected_sheet_version_id` IS NOT NULL) DESC, scl.`updated_at` DESC, scl.`id` DESC LIMIT 1
  )
WHERE EXISTS (SELECT 1 FROM `sequence_cast_looks` scl WHERE scl.`look_id` = `character_looks`.`id`);
