-- One-shot reset for rows stuck in a generating-style status.
--
-- See issue #727. Run when QStash workflows were cancelled mid-run (manually
-- or by a deploy / restart) and their DB rows never got flipped back. Sets
-- everything to 'failed' so the UI shows a retry affordance.
--
-- Production:  bunx wrangler d1 execute velro-prd --remote --file=scripts/unstick-stuck-jobs.sql
-- Dry-run counts are in the issue / plan; run them first.

-- frames: 4 independent pipelines
UPDATE frames SET thumbnail_status = 'failed', updated_at = unixepoch()
  WHERE thumbnail_status = 'generating';
UPDATE frames SET video_status = 'failed', updated_at = unixepoch()
  WHERE video_status = 'generating';
UPDATE frames SET variant_image_status = 'failed', updated_at = unixepoch()
  WHERE variant_image_status = 'generating';
UPDATE frames SET audio_status = 'failed', updated_at = unixepoch()
  WHERE audio_status = 'generating';

-- frame_variants: image + shot-variant pipelines
UPDATE frame_variants SET status = 'failed', updated_at = unixepoch()
  WHERE status = 'generating';
UPDATE frame_variants SET shot_variant_status = 'failed', updated_at = unixepoch()
  WHERE shot_variant_status = 'generating';

-- sequence_music_variants: music track rows ('pending', #1115), and the
-- sequence claims that named them
UPDATE sequences SET pending_promote_music_variant_id = NULL
  WHERE pending_promote_music_variant_id IN (
    SELECT id FROM sequence_music_variants WHERE status = 'pending'
  );
UPDATE sequence_music_variants SET status = 'failed', updated_at = unixepoch()
  WHERE status = 'pending';

-- sequence_elements (uses 'analyzing')
UPDATE sequence_elements SET vision_status = 'failed', updated_at = unixepoch()
  WHERE vision_status = 'analyzing';
