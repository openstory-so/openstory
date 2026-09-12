-- Retire the video models that can do neither 1s clips nor in-clip
-- multi-shot (#1511): LTX 2.3 Pro, Veo 3.1, MiniMax Hailuo 2.3.
--
-- HAND-WRITTEN ON PURPOSE. Pure data backfill, no schema diff, so drizzle-kit
-- cannot emit it; generated with `bun db:generate --custom`. It is a
-- migration and not a script because every deploy path only ever runs
-- `wrangler d1 migrations apply`.
--
-- WHY: a sequence still pointing at a dropped key would be silently swapped
-- to the default at every launch by `safeImageToVideoModel` while the picker
-- kept showing the retired id. Remap once so what the UI shows is what
-- renders. `seedance_v2` is DEFAULT_VIDEO_MODEL, the same fallback the code
-- path takes. Style recommendations pointing at a dropped model are cleared
-- (the picker already treats an unknown recommendation as "none").
-- Rendered versions keep their provenance: `video_variants.model` and the
-- motion `shot_prompt_versions` rows are history, not selections.
UPDATE sequences
SET video_model = 'seedance_v2'
WHERE video_model IN ('ltx_2_3_pro', 'veo3_1', 'minimax_hailuo_02');
--> statement-breakpoint
UPDATE styles
SET recommended_video_model = NULL
WHERE recommended_video_model IN ('ltx_2_3_pro', 'veo3_1', 'minimax_hailuo_02');
