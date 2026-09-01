-- #1419 PR A — the same snapshot as
-- 20260901073033_backfill_character_sheet_variants, for `sequence_locations`
-- against `location_sheet_variants`. Read that file's header first; every
-- decision below is the same one — including why
-- `selected_reference_version_id` is deliberately left alone — and only the
-- differences are noted here.
--
-- Production shape: 2,279 of 2,387 sequence locations carry
-- `reference_image_url` with `selected_reference_version_id` NULL.
--
-- `location_sheet_variants` is shared with team-level `location_library` rows
-- via `parent_type`, so every predicate is scoped to
-- `parent_type = 'sequence_location'`. Library locations keep their own mirror
-- columns and are out of scope for #1419.
--
-- The snapshot reuses the sequence location's own ULID as its id, same as the
-- character migration. `location_sheet_variants.id` is shared across both
-- parent types, but a `location_library` ULID can never equal a
-- `sequence_locations` one, so the primary key stays safe when the library
-- surface is backfilled later.

INSERT INTO `location_sheet_variants` (
  `id`,
  `parent_type`,
  `parent_id`,
  `model`,
  `url`,
  `storage_path`,
  `status`,
  `generated_at`,
  `error`,
  `input_hash`,
  `created_at`,
  `updated_at`
)
SELECT
  l.`id`,
  'sequence_location',
  l.`id`,
  'prior',
  l.`reference_image_url`,
  l.`reference_image_path`,
  l.`reference_status`,
  l.`reference_generated_at`,
  l.`reference_error`,
  l.`reference_input_hash`,
  COALESCE(l.`reference_generated_at`, l.`updated_at`),
  COALESCE(l.`reference_generated_at`, l.`updated_at`)
FROM `sequence_locations` l
LEFT JOIN `location_sheet_variants` v ON v.`id` = l.`id`
WHERE l.`selected_reference_version_id` IS NULL
  AND v.`id` IS NULL
  AND (l.`reference_image_url` IS NOT NULL OR l.`reference_status` <> 'pending');
