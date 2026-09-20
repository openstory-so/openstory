/**
 * "Update all" cascade depth (#1085). Cumulative levels — each includes the
 * ones before it:
 *
 *   - 'prompts' — stale visual/motion prompts only. Nothing renders.
 *   - 'images'  — + images: stale stills re-render, and a still whose visual
 *                 prompt regenerates in this run is re-rendered too (it would
 *                 read stale the moment the prompt lands). Never creates a
 *                 FIRST still.
 *   - 'dialogue'— + dialogue audio: re-records a reading whose voice or
 *                 lines moved. Never creates a FIRST recording. Video is
 *                 left for the next tick so the new take can be reviewed.
 *   - 'video'   — + videos: a shot whose motion prompt, still, or dialogue
 *                 changed in this run gets its video re-rendered. Never
 *                 renders a FIRST video.
 *   - 'music'   — + sequence music: regenerates a stale music prompt, then
 *                 the track itself when one already exists.
 *
 * Kept in its own dependency-light module because both the client menu and
 * the server fn / workflow need the vocabulary.
 */

export const UPDATE_STALE_DEPTHS = [
  'prompts',
  'images',
  'dialogue',
  'video',
  'music',
] as const;

export type UpdateStaleDepth = (typeof UPDATE_STALE_DEPTHS)[number];

/**
 * Default cascade depth when a run (or client) omits `depth`. Prompts,
 * stills, and out-of-date dialogue; video and music stay one click away.
 */
export const DEFAULT_UPDATE_STALE_DEPTH: UpdateStaleDepth = 'dialogue';

export const UPDATE_STALE_DEPTH_RANK: Record<UpdateStaleDepth, number> = {
  prompts: 0,
  images: 1,
  dialogue: 2,
  video: 3,
  music: 4,
};

/** Does `depth` include level `level`? (Levels are cumulative.) */
export function depthIncludes(
  depth: UpdateStaleDepth,
  level: UpdateStaleDepth
): boolean {
  return UPDATE_STALE_DEPTH_RANK[depth] >= UPDATE_STALE_DEPTH_RANK[level];
}

/** Option copy shared by every "Update all" trigger. */
export const UPDATE_STALE_DEPTH_LABELS: Record<UpdateStaleDepth, string> = {
  prompts: 'Prompts only',
  images: 'Prompts + images',
  dialogue: 'Prompts, images + dialogue',
  video: 'Prompts, images, dialogue + videos',
  music: 'Everything, incl. music',
};
