/**
 * Which versions an artifact read (#1862).
 *
 * A prompt, a still and a clip are made from inputs that have history: the
 * scene's script version, the style snapshot, each character's pinned bible
 * and the look it wore, each location's bible, and (for a still) the sheet
 * each reference was drawn from. The hash says THAT they moved; this says
 * WHICH rows the run read, so a stale verdict can name the fields by an
 * exact pointer compare against what the sequence pins now, never by "the
 * version that was newest at that time".
 *
 * Provenance only: never part of any hash body (no stored digest moves),
 * never filtered in SQL, and never a copy of authored data — ids only. A
 * row written before the column exists has none; its cause falls back to
 * the pin walk or the clock and says so.
 */

export type PromptInputVersions = {
  /** `scene_script_versions.id`; null when the scene had no version row yet. */
  scene: string | null;
  /** `sequence_style_versions.id`; null while an automatic style is still deriving. */
  style: string | null;
  /**
   * By character row id, only the characters this prompt references: the
   * `character_bible_versions` row the sequence pinned and the
   * `character_look_versions` row of the look worn in this shot's scene.
   */
  characters: Record<string, { bible: string; look: string }>;
  /** By sequence-location row id → `location_bible_versions.id` (null before #1600). */
  locations: Record<string, string | null>;
};

/** A still also reads a sheet per reference it was given. */
export type StillInputVersions = PromptInputVersions & {
  /** By character row id → `character_sheet_variants.id`; null when the look had no sheet. */
  sheets: Record<string, string | null>;
  /** By sequence-location row id → `location_sheet_variants.id`; null when none. */
  locationSheets: Record<string, string | null>;
};
