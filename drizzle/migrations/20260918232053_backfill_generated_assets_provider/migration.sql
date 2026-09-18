-- HAND-WRITTEN DATA BACKFILL (#1681). No schema diff: drizzle-kit cannot emit
-- this, so the file was created with `bun db:generate --custom`.
--
-- `generated_assets.provider` was typed as the literal 'fal' and written as a
-- constant at queue time, so every Studio generation that actually rendered on
-- a native via (BytePlus, xAI, Google) is labelled fal. `content_provenance`
-- was stamped with the real via by the same run, so it is the source of truth.
--
-- Set-based UPDATE ... FROM, not a correlated subquery (D1 CPU limit). The
-- provider list is the `MediaVia` union minus 'fal': rows already say fal, and
-- it keeps any other provenance value out of the column. Catalog outputs are
-- recorded as `<assetId>#<n>`; they never join, and they are fal anyway.
-- Idempotent: a second run matches nothing.
UPDATE `generated_assets`
SET `provider` = p.`provider`
FROM (
  SELECT `asset_id`, `provider`
  FROM `content_provenance`
  WHERE `asset_kind` = 'generated_asset'
    AND `provider` IN ('byteplus', 'xai', 'google')
) AS p
WHERE `generated_assets`.`id` = p.`asset_id`
  AND `generated_assets`.`provider` <> p.`provider`;
