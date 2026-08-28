-- #1108 Phase 1 — PROMPT_INPUT_HASH_VERSION 4 → 5.
--
-- Originally this migration NULLed every stored prompt hash so v4 rows would
-- read 'untracked' instead of universally 'stale' after the v5 body change
-- (drop sceneNumber, drop display names). That catalog wipe is no longer
-- needed: verify is dual-hash (`*InputHashMatches` in src/lib/ai/input-hash.ts)
-- — a stored digest is fresh if it matches the current stamp OR a legacy
-- v4 / named / titled digest of the same live inputs.
--
-- The folder stays so the snapshot chain and `d1_migrations` journal keep a
-- contiguous history. Statement is a no-op. Do not delete this file.
--
-- Follow-up: delete the legacy hashers after LEGACY_HASH_UNTIL (2026-09-28).
-- https://github.com/openstory-so/openstory/issues/1371

SELECT 1;
