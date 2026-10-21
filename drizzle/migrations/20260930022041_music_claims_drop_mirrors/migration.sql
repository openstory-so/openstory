-- #1115 — the sequence's music IS its version rows. Drop the
-- `sequences.music_*` mirror (url, path, status, generated_at, error, prompt,
-- tags, prompt_input_hash); `music_model` stays as the audio-model setting.
-- Reads now project the selected track (`selected_music_variant_id`), the
-- selected prompt (`selected_music_prompt_version_id`) and the newest
-- `is_primary` track row's lifecycle; a primary run lands through the claim
-- `pending_promote_music_variant_id`. The partial unique indexes forced one
-- row per (sequence, model), updated in place; tracks are append-only now.
--
-- THE BACKFILL BETWEEN THE INDEX DROPS AND THE DROP COLUMNs IS HAND-WRITTEN
-- (a data backfill has no schema diff, so drizzle-kit cannot emit it); every
-- other statement is drizzle-kit's, in the order it emitted them. One
-- migration per issue, so they share this file.
--
-- What users hear and read today is the mirror, so:
--   1. A mirror track (`music_url`) no completed row carries gets a snapshot
--      track row: completed, primary, the mirror's prompt/tags/path, no input
--      hash (reads untracked, never falsely fresh).
--   2. `selected_music_variant_id` ← the newest completed row with the
--      mirror's url.
--   3. A mirror prompt no version row matches (prompt, tags and hash, `IS`
--      so NULLs compare) gets a snapshot version, source 'restored' (outside
--      the AI hash unique index), keeping the mirror's hash so staleness
--      keeps tracking; analysis_model NULL (unknown — reads fall back to the
--      sequence's analysis model, as they did).
--   4. `selected_music_prompt_version_id` ← the newest matching version.
--   5. Rows of another model than the sequence's `music_model` are an added
--      model's tracks (#547): `is_primary = 0`, so they never read as the
--      sequence's status.
--   6. A failed mirror with no track gets a failed primary row carrying
--      `music_error`, so the failure survives the drop. Its id is the
--      sequence's (the oldest), so that sequence's other rows leave the
--      status race (`is_primary = 0`) — otherwise a newer row would outrank
--      it and the error would vanish. With no track selected they were not
--      the sequence's music anyway; they stay history.
-- Not backfilled: a failed regeneration over a live track (reads completed)
-- and 'generating' (an in-flight run opens its own row on replay; a dead one
-- reads by its rows).
--
-- A snapshot row's model is the sequence's `music_model`; where that is NULL
-- it is 'elevenlabs_music', the value of DEFAULT_MUSIC_MODEL (a label on a
-- snapshot only — the column is NOT NULL, and nothing selects by it).
--
-- THE IDS ARE THE SEQUENCE'S OWN ULID. SQL cannot mint a ULID and ids only
-- need to be unique within their table; steps 1 and 6 are exclusive (url vs
-- no url), and no app-written row carries a sequence's id. Replay-safe: each
-- insert LEFT JOINs its own id, and the pointer updates are idempotent.
-- Set-based INSERT … SELECT and UPDATE … FROM, no correlated subqueries
-- (D1's remote CPU limit, #1019). ADD/DROP COLUMN and DROP INDEX rebuild no
-- table, so the #612 cascade trap does not apply.

ALTER TABLE `sequence_music_variants` ADD `is_primary` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sequences` ADD `selected_music_variant_id` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `selected_music_prompt_version_id` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `pending_promote_music_variant_id` text;--> statement-breakpoint
DROP INDEX IF EXISTS `sequence_music_variants_primary_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `sequence_music_variants_divergent_key`;--> statement-breakpoint
INSERT INTO `sequence_music_variants` (
  `id`, `sequence_id`, `url`, `storage_path`, `prompt`, `tags`, `model`,
  `status`, `is_primary`, `generated_at`, `created_at`, `updated_at`
)
SELECT
  s.`id`, s.`id`, s.`music_url`, s.`music_path`, s.`music_prompt`,
  s.`music_tags`, COALESCE(s.`music_model`, 'elevenlabs_music'), 'completed',
  1, s.`music_generated_at`, s.`updated_at`, s.`updated_at`
FROM `sequences` s
LEFT JOIN (
  SELECT DISTINCT v.`sequence_id`
  FROM `sequence_music_variants` v
  JOIN `sequences` ms ON ms.`id` = v.`sequence_id`
  WHERE v.`status` = 'completed' AND v.`url` = ms.`music_url`
) matched ON matched.`sequence_id` = s.`id`
LEFT JOIN `sequence_music_variants` own ON own.`id` = s.`id`
WHERE s.`music_url` IS NOT NULL
  AND matched.`sequence_id` IS NULL
  AND own.`id` IS NULL;--> statement-breakpoint
UPDATE `sequences`
SET `selected_music_variant_id` = picked.`variant_id`
FROM (
  SELECT v.`sequence_id`, MAX(v.`id`) AS `variant_id`
  FROM `sequence_music_variants` v
  JOIN `sequences` ms ON ms.`id` = v.`sequence_id`
  WHERE v.`status` = 'completed' AND v.`url` = ms.`music_url`
  GROUP BY v.`sequence_id`
) picked
WHERE `sequences`.`id` = picked.`sequence_id`;--> statement-breakpoint
INSERT INTO `sequence_music_prompt_versions` (
  `id`, `sequence_id`, `prompt_type`, `prompt`, `tags`, `source`,
  `input_hash`, `analysis_model`, `created_at`, `created_by`
)
SELECT
  s.`id`, s.`id`, 'music', s.`music_prompt`, s.`music_tags`, 'restored',
  s.`music_prompt_input_hash`, NULL, s.`updated_at`, NULL
FROM `sequences` s
LEFT JOIN (
  SELECT DISTINCT p.`sequence_id`
  FROM `sequence_music_prompt_versions` p
  JOIN `sequences` ms ON ms.`id` = p.`sequence_id`
  WHERE p.`prompt` = ms.`music_prompt`
    AND p.`tags` IS ms.`music_tags`
    AND p.`input_hash` IS ms.`music_prompt_input_hash`
) matched ON matched.`sequence_id` = s.`id`
LEFT JOIN `sequence_music_prompt_versions` own ON own.`id` = s.`id`
WHERE s.`music_prompt` IS NOT NULL
  AND matched.`sequence_id` IS NULL
  AND own.`id` IS NULL;--> statement-breakpoint
UPDATE `sequences`
SET `selected_music_prompt_version_id` = picked.`version_id`
FROM (
  SELECT p.`sequence_id`, MAX(p.`id`) AS `version_id`
  FROM `sequence_music_prompt_versions` p
  JOIN `sequences` ms ON ms.`id` = p.`sequence_id`
  WHERE p.`prompt` = ms.`music_prompt`
    AND p.`tags` IS ms.`music_tags`
    AND p.`input_hash` IS ms.`music_prompt_input_hash`
  GROUP BY p.`sequence_id`
) picked
WHERE `sequences`.`id` = picked.`sequence_id`;--> statement-breakpoint
UPDATE `sequence_music_variants`
SET `is_primary` = 0
FROM `sequences` s
WHERE s.`id` = `sequence_music_variants`.`sequence_id`
  AND s.`music_model` IS NOT NULL
  AND `sequence_music_variants`.`model` != s.`music_model`;--> statement-breakpoint
INSERT INTO `sequence_music_variants` (
  `id`, `sequence_id`, `prompt`, `tags`, `model`, `status`, `error`,
  `is_primary`, `created_at`, `updated_at`
)
SELECT
  s.`id`, s.`id`, s.`music_prompt`, s.`music_tags`,
  COALESCE(s.`music_model`, 'elevenlabs_music'), 'failed', s.`music_error`, 1,
  s.`updated_at`, s.`updated_at`
FROM `sequences` s
LEFT JOIN `sequence_music_variants` own ON own.`id` = s.`id`
WHERE s.`music_status` = 'failed'
  AND s.`music_url` IS NULL
  AND own.`id` IS NULL;--> statement-breakpoint
UPDATE `sequence_music_variants`
SET `is_primary` = 0
FROM `sequences` s
WHERE s.`id` = `sequence_music_variants`.`sequence_id`
  AND s.`music_status` = 'failed'
  AND s.`music_url` IS NULL
  AND `sequence_music_variants`.`id` != s.`id`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_url`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_path`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_status`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_generated_at`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_error`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_prompt`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_tags`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `music_prompt_input_hash`;