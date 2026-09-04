-- #1419 PR A — snapshot every pre-versioning character sheet as a
-- `character_sheet_variants` row, so the mirror columns on `characters` can be
-- dropped without losing the image (PR C).
--
-- HAND-WRITTEN ON PURPOSE. This has no schema diff, so drizzle-kit cannot emit
-- it; generated with `bun db:generate --custom`. It has to be a migration
-- rather than a script because all three deploy paths (Workers Builds prod, PR
-- previews provisioning a fresh `openstory-pr-<n>`, and Deploy-button clones)
-- run `wrangler d1 migrations apply` and none of them run scripts.
--
-- WHY: ~93% of production predates #1108 sheet versioning — 1,612 of 1,729
-- characters carry `sheet_image_url` with `selected_sheet_version_id` NULL.
-- There is no version row to read those images from.
--
-- WHICH ROWS. Pointer NULL (a row that already points at a version has been
-- versioned) AND either a url or a status that is not 'pending'. The status
-- half is the part a naive `url IS NOT NULL` backfill would drop on the floor:
-- 26 failures (carrying `sheet_error`) and 6 in-flight generations have no url
-- at all, and dropping `sheet_status` in PR C would silently lose them.
-- url-less 'pending' rows are skipped deliberately — a character with no
-- versions already derives back to 'pending', so a row for them would be pure
-- noise. Soft-deleted characters ARE included; restore is meant to be lossless.
--
-- `model = 'prior'`, not a new 'legacy' token: that is the sentinel
-- `characterSheetVariants.applyConvergent` ALREADY writes when it snapshots a
-- pre-versioning image (scoped/character-sheet-variants.ts), and
-- `resolveSheetImageModel` already skips it when picking a model to re-roll
-- with. This backfill is that same snapshot, applied in bulk instead of lazily.
--
-- THE ID IS THE CHARACTER'S OWN ULID. Ids are app-generated ULIDs everywhere
-- and SQL cannot mint one, so the snapshot reuses its parent's — ids only have
-- to be unique within their own table, and one snapshot per character makes
-- that hold. It also makes the migration deterministic: the replay gate below
-- is a primary-key seek, and `applyConvergent` inserts its lazy snapshot under
-- the same id with `onConflictDoNothing`, so the two paths cannot duplicate
-- each other.
--
-- IT DOES NOT WRITE `selected_sheet_version_id`, and that is the whole reason
-- this ships alone. `resolveSceneShotImageReferences` hashes
-- `selectedSheetVersionId ?? sheetInputHash` into every shot's thumbnail input
-- hash (workflows/sheet-snapshots.ts), and `computeShotStaleness` compares
-- that live hash against the one stamped at generation. Filling the pointer
-- moves the ingredient for all 1,612 characters, so every shot referencing one
-- flips to 'stale' the moment this deploys — the exact failure #867 already
-- caused once by changing what goes into that hash. The pointer is PR B's job,
-- once reads go through a helper that does not feed staleness. Leaving it NULL
-- also keeps this migration trivially reversible: delete the rows.
--
-- Set-based INSERT … SELECT, not a correlated subquery — those trip D1's
-- remote CPU limit, and migrations apply BEFORE deploy, so a slow one freezes
-- the deploy (#1019). Idempotent: the LEFT JOIN on the primary key means a
-- re-run inserts nothing. Touches no schema, so there is no table rebuild and
-- the #612 cascade trap does not apply.

INSERT INTO `character_sheet_variants` (
  `id`,
  `character_id`,
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
  c.`id`,
  c.`id`,
  'prior',
  c.`sheet_image_url`,
  c.`sheet_image_path`,
  c.`sheet_status`,
  c.`sheet_generated_at`,
  c.`sheet_error`,
  c.`sheet_input_hash`,
  COALESCE(c.`sheet_generated_at`, c.`updated_at`),
  COALESCE(c.`sheet_generated_at`, c.`updated_at`)
FROM `characters` c
LEFT JOIN `character_sheet_variants` v ON v.`id` = c.`id`
WHERE c.`selected_sheet_version_id` IS NULL
  AND v.`id` IS NULL
  AND (c.`sheet_image_url` IS NOT NULL OR c.`sheet_status` <> 'pending');
