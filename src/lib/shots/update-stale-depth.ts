/**
 * "Update all" cascade depth (#1085). Cumulative levels — each includes the
 * ones before it:
 *
 *   - 'prompts' — stale visual/motion prompts only. Nothing renders.
 *   - 'images'  — + images: stale stills re-render, and a still whose visual
 *                 prompt regenerates in this run is re-rendered too (it would
 *                 read stale the moment the prompt lands). Never creates a
 *                 FIRST still.
 *   - 'video'   — + videos: a shot whose motion prompt or still changed in
 *                 this run gets its video re-rendered. Never renders a FIRST
 *                 video.
 *   - 'music'   — + sequence music: regenerates a stale music prompt, then
 *                 the track itself when one already exists.
 *
 * Kept in its own dependency-light module because both the client menu and
 * the server fn / workflow need the vocabulary.
 */

export const UPDATE_STALE_DEPTHS = [
  'prompts',
  'images',
  'video',
  'music',
] as const;

export type UpdateStaleDepth = (typeof UPDATE_STALE_DEPTHS)[number];

/**
 * Default cascade depth when a run (or client) omits `depth`. Matches the
 * pre–depth-picker gating most closely: prompts + affected stills, no video
 * or music.
 */
export const DEFAULT_UPDATE_STALE_DEPTH: UpdateStaleDepth = 'images';

const RANK: Record<UpdateStaleDepth, number> = {
  prompts: 0,
  images: 1,
  video: 2,
  music: 3,
};

/** Does `depth` include level `level`? (Levels are cumulative.) */
export function depthIncludes(
  depth: UpdateStaleDepth,
  level: UpdateStaleDepth
): boolean {
  return RANK[depth] >= RANK[level];
}

/** Option copy shared by every "Update all" trigger. */
export const UPDATE_STALE_DEPTH_LABELS: Record<UpdateStaleDepth, string> = {
  prompts: 'Prompts only',
  images: 'Prompts + images',
  video: 'Prompts, images + videos',
  music: 'Everything, incl. music',
};
