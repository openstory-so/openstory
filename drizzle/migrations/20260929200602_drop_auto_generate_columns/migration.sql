-- #1118 — `sequences.generation_stop_at` is the only word on how far a run
-- goes. Drop the derived `auto_generate_motion / auto_generate_music` columns.
--
-- THE BACKFILL BELOW IS HAND-WRITTEN (a data backfill has no schema diff, so
-- drizzle-kit cannot emit it); the two DROP COLUMNs at the end are
-- drizzle-kit's. One migration per issue, so they share this file.
--
-- Rows from before #1408 have no stop-at and were read through the flags.
-- Give them the stop the flags meant (`stopAtFromFlags`): motion + music →
-- music, motion → motion, anything else (music without motion included) →
-- images. After this every row has a stop-at; `resolveStopAt` throws on none.
UPDATE `sequences` SET `generation_stop_at` = CASE
  WHEN `auto_generate_motion` AND `auto_generate_music` THEN 'music'
  WHEN `auto_generate_motion` THEN 'motion'
  ELSE 'images'
END
WHERE `generation_stop_at` IS NULL;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `auto_generate_motion`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `auto_generate_music`;