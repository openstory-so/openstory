-- #1788 — the character's voice IS its selected `character_voice_versions`
-- row. Drop the `characters.voice_id / voice_description / voice_previews`
-- mirror, after snapshotting any mirror the selected row does not match.
--
-- THE BACKFILL BELOW IS HAND-WRITTEN (a data backfill has no schema diff, so
-- drizzle-kit cannot emit it); the three DROP COLUMNs at the end are
-- drizzle-kit's. One migration per issue, so they share this file.
--
-- What users hear today is the mirror, so a character whose resolved voice
-- (the selected row, or nothing) differs from the mirror gets the mirror as
-- a new completed version, and is pointed at it. Two cases:
--   (a) no selected row (rows from before voice history, or a dangling
--       pointer) but a mirror column is set;
--   (b) a selected row whose voice id / description / previews differ from
--       the mirror (`IS NOT`, so NULLs compare) — e.g. a re-cast `coalesce`
--       that filled the mirror without writing a version.
--
-- THE ID IS THE CHARACTER'S OWN ULID. SQL cannot mint a ULID and ids only
-- need to be unique within their table. A character is in at most one case,
-- so it needs at most one snapshot, and no app-written version can carry a
-- character's id (they are fresh `generateId()` ULIDs). Replay-safe: the
-- LEFT JOIN on that id inserts nothing twice, and the pointer only moves to a
-- row at that id holding exactly the mirror's values.
--
-- `source`: 'library' when the voice id is the cast talent's (the old
-- `create` labelled that copy the same way), 'generated' for any other voice
-- id, 'analysis' for a description with no voice id. `enabled` is the row's
-- `use_voice`; `created_at` is the row's `updated_at`, the last moment the
-- mirror can have been written. No hash reads the voice pointer, so nothing
-- goes stale on deploy.
--
-- Soft-deleted characters are included: `getVoiceReferenceCount` counts them
-- so a failed release keeps its ElevenLabs slot referenced.
-- Set-based INSERT … SELECT and UPDATE … IN (SELECT), no correlated
-- subqueries (D1's remote CPU limit, #1019). DROP COLUMN rebuilds no table,
-- so the #612 cascade trap does not apply.

INSERT INTO `character_voice_versions` (
  `id`,
  `character_id`,
  `voice_id`,
  `description`,
  `previews`,
  `enabled`,
  `source`,
  `status`,
  `created_by`,
  `created_at`
)
SELECT
  c.`id`,
  c.`id`,
  c.`voice_id`,
  c.`voice_description`,
  c.`voice_previews`,
  c.`use_voice`,
  CASE
    WHEN c.`voice_id` IS NOT NULL AND c.`voice_id` = t.`voice_id` THEN 'library'
    WHEN c.`voice_id` IS NOT NULL THEN 'generated'
    ELSE 'analysis'
  END,
  'completed',
  NULL,
  c.`updated_at`
FROM `characters` c
LEFT JOIN `character_voice_versions` sv ON sv.`id` = c.`selected_voice_version_id`
LEFT JOIN `character_voice_versions` own ON own.`id` = c.`id`
LEFT JOIN `talent` t ON t.`id` = c.`talent_id`
WHERE own.`id` IS NULL
  AND (
    (
      sv.`id` IS NULL
      AND (
        c.`voice_id` IS NOT NULL
        OR c.`voice_description` IS NOT NULL
        OR c.`voice_previews` IS NOT NULL
      )
    )
    OR (
      sv.`id` IS NOT NULL
      AND (
        sv.`voice_id` IS NOT c.`voice_id`
        OR sv.`description` IS NOT c.`voice_description`
        OR sv.`previews` IS NOT c.`voice_previews`
      )
    )
  );
--> statement-breakpoint
UPDATE `characters`
SET `selected_voice_version_id` = `id`
WHERE `id` IN (
  SELECT c.`id`
  FROM `characters` c
  JOIN `character_voice_versions` own ON own.`id` = c.`id`
  WHERE own.`character_id` = c.`id`
    AND own.`voice_id` IS c.`voice_id`
    AND own.`description` IS c.`voice_description`
    AND own.`previews` IS c.`voice_previews`
    AND c.`selected_voice_version_id` IS NOT c.`id`
);
--> statement-breakpoint
ALTER TABLE `characters` DROP COLUMN `voice_id`;--> statement-breakpoint
ALTER TABLE `characters` DROP COLUMN `voice_description`;--> statement-breakpoint
ALTER TABLE `characters` DROP COLUMN `voice_previews`;