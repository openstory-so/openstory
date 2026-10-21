-- Data repair (#1889): analysis palettes are not user overrides. Generated with
-- bun db:generate --custom --name=clear_scene_palette_overrides; no schema change.
UPDATE scene_script_versions SET continuity = json_remove(continuity, '$.colorPalette') WHERE continuity IS NOT NULL;
--> statement-breakpoint
UPDATE scenes SET continuity = json_remove(continuity, '$.colorPalette') WHERE continuity IS NOT NULL;
