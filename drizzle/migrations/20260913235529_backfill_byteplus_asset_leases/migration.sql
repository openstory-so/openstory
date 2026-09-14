-- #1531 — carry every unexpired single-row lease on `byteplus_assets` over to
-- a `byteplus_asset_leases` row before a later migration drops the column.
--
-- HAND-WRITTEN ON PURPOSE. A data backfill has no schema diff, so drizzle-kit
-- cannot emit it; generated with `bun db:generate --custom`.
--
-- WHY: a Seedance job still polling across the deploy holds its stills through
-- `lease_expires_at`. Dropping it unmigrated makes those slots evictable at
-- once, and deleting an `asset://` mid-poll 400s the job.
--
-- OWNER: `legacy:<slot id>`. No new run releases by that owner, so these rows
-- simply expire on their old deadline. The lease id reuses the slot's ULID
-- (ids only have to be unique within their own table).
INSERT INTO `byteplus_asset_leases` (`id`, `identity`, `owner`, `expires_at`)
SELECT `id`, `identity`, 'legacy:' || `id`, `lease_expires_at`
FROM `byteplus_assets`
WHERE `lease_expires_at` > unixepoch()
ON CONFLICT DO NOTHING;
