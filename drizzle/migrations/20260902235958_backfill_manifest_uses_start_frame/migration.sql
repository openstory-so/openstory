-- Stamp `usesStartFrame` onto every existing `video_variants.manifest` entry.
--
-- HAND-WRITTEN ON PURPOSE. Pure data backfill, no schema diff, so drizzle-kit
-- cannot emit it; generated with `bun db:generate --custom`. It is a
-- migration and not a script because every deploy path only ever runs
-- `wrangler d1 migrations apply`.
--
-- WHY: `VideoManifestEntry.usesStartFrame` is required from this release on.
-- Rows written before it carry no key, and a null `frameVersionId` cannot
-- stand in for it: that null also means "not pinned" (#1380) and, next to a
-- null prompt id, "legacy provenance".
--
-- WHAT IT STAMPS: the shot's CURRENT mode,
-- `COALESCE(shots.use_start_frame, NOT sequences.reference_only)`, the same
-- resolution `usesStartFrame()` makes in code. That IS the render mode rather
-- than a guess, because the per-shot switch ships in the same release as this
-- stamp: no existing row was rendered in one mode and flipped since. A
-- manifest shot that no longer exists falls back to the sequence default.
--
-- WHICH ROWS: only manifests with no `usesStartFrame` anywhere, so a replay is
-- a no-op. Entry order is preserved (`ORDER BY je.key`, the array index). The
-- stored `input_hash` is left alone: it is never re-derived from a stored
-- manifest, only compared against the hash of a NEW one.
-- Set-based (one join-driven scan, keyed update) rather than a per-row
-- scalar subquery, which trips D1's remote CPU-time limit on a large table
-- (#1019). Manifests with no entries have no json_each rows and are left as
-- they are.
UPDATE video_variants
SET manifest = stamped.manifest
FROM (
  SELECT
    vv.id AS id,
    json_group_array(
      json(
        json_set(
          je.value,
          '$.usesStartFrame',
          json(
            CASE
              WHEN COALESCE(s.use_start_frame, NOT seq.reference_only) THEN 'true'
              ELSE 'false'
            END
          )
        )
      )
      ORDER BY je.key
    ) AS manifest
  FROM video_variants AS vv
  JOIN sequences AS seq ON seq.id = vv.sequence_id
  JOIN json_each(vv.manifest) AS je
  LEFT JOIN shots AS s ON s.id = json_extract(je.value, '$.shotId')
  WHERE json_valid(vv.manifest)
    AND vv.manifest NOT LIKE '%"usesStartFrame"%'
  GROUP BY vv.id
) AS stamped
WHERE video_variants.id = stamped.id;
