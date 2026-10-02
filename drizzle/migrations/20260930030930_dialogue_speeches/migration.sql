-- #1913 — the uncut file from one dialogue synthesis call is a SPEECH;
-- "recording" is kept for the mic (#1802).
--
-- The renames and index swaps are drizzle-kit's (rename hints, no table
-- rebuild, so the #612 cascade trap does not apply). The CHECK keeps its
-- `dialogue_recordings_duration` name: renaming a CHECK rebuilds the table.
-- The data rewrite at the end is HAND-WRITTEN (stored values have no schema
-- diff). One migration per issue, so they share this file.
ALTER TABLE `dialogue_recordings` RENAME TO `dialogue_speeches`;--> statement-breakpoint
ALTER TABLE `shot_dialogue_sections` RENAME COLUMN `recording_id` TO `speech_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_dialogue_recordings_sequence_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_shot_dialogue_sections_recording`;--> statement-breakpoint
CREATE INDEX `idx_dialogue_speeches_sequence_created` ON `dialogue_speeches` (`sequence_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shot_dialogue_sections_speech` ON `shot_dialogue_sections` (`speech_id`);--> statement-breakpoint
-- HAND-WRITTEN data rewrite.
--
-- `shot_dialogue_sections.source`: 'recorded' is now 'generated' ('context'
-- stays). A text enum with no CHECK, so no DDL.
UPDATE `shot_dialogue_sections` SET `source` = 'generated' WHERE `source` = 'recorded';--> statement-breakpoint
-- `shots.audio_clips`: each clip's `recordingId` key becomes `speechId`,
-- same value. Only clips that carry the key are touched and entry order is
-- kept (`ORDER BY je.key`, the array index), so a replay is a no-op. No hash
-- reads the key: manifests record clip ids only. Set-based (one join-driven
-- scan, keyed update), not a correlated subquery (D1's remote CPU limit,
-- #1019). The dead `shot_prompt_versions.audio_clips` is left alone.
UPDATE `shots`
SET `audio_clips` = renamed.audio_clips
FROM (
  SELECT
    s.id AS id,
    json_group_array(
      json(
        CASE
          WHEN json_type(je.value, '$.recordingId') IS NOT NULL THEN json_remove(
            json_set(je.value, '$.speechId', json_extract(je.value, '$.recordingId')),
            '$.recordingId'
          )
          ELSE je.value
        END
      )
      ORDER BY je.key
    ) AS audio_clips
  FROM `shots` AS s
  JOIN json_each(s.audio_clips) AS je
  WHERE json_valid(s.audio_clips)
    AND s.audio_clips LIKE '%"recordingId"%'
  GROUP BY s.id
) AS renamed
WHERE `shots`.`id` = renamed.id;
