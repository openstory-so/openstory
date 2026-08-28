-- #1108 Phase 1 — PROMPT_INPUT_HASH_VERSION 4 → 5.
--
-- v5 drops `sceneNumber` from the prompt-hash scene surface (position is
-- identity, not content — a pure scene reorder must not re-stale prompts).
-- Every stored prompt hash was computed under v4 and can therefore never
-- match a v5 recompute: without this migration EVERY prompt in the product
-- reads "stale" after the deploy and Update-all offers to regenerate the
-- whole catalog (the #867 false-positive class, at full blast).
--
-- The staleness handlers short-circuit a NULL stored hash to 'untracked'
-- ("no opinion", no regenerate prompt) — the documented deploy step for a
-- version bump (see PROMPT_INPUT_HASH_VERSION in src/lib/ai/input-hash.ts).
-- The next regeneration of each prompt stamps a fresh v5 hash and staleness
-- tracking resumes.
--
-- `pending_input_hash` claims are left alone: they are transient (live runs
-- complete within minutes) and self-invalidate — a claim whose hash no longer
-- matches the live recompute simply stops matching, so the artifact honestly
-- reads 'stale' instead of 'updating' until the run lands.
--
-- Data-only: no DDL, no table rebuild, the #612 cascade trap does not apply.
-- Idempotent: re-running nulls NULL to NULL.

UPDATE `frame_prompt_versions` SET `input_hash` = NULL;--> statement-breakpoint
UPDATE `shot_prompt_versions` SET `input_hash` = NULL;--> statement-breakpoint
UPDATE `sequences` SET `music_prompt_input_hash` = NULL;--> statement-breakpoint
-- The music prompt's version history carries the same v4 hash. Staleness
-- reads the `sequences` mirror above, so this row is dedup-only today — but
-- the visual/motion staleness paths already fall back to "latest version with
-- a non-null input_hash" when the selected row has none, and leaving v4
-- values here arms that same fallback for music the moment it is added.
UPDATE `sequence_music_prompt_versions` SET `input_hash` = NULL;
