/**
 * "Update all" cascade depth (#1085). Cumulative levels — each includes the
 * ones before it. Update all is the generation plan filtered to `stale` up
 * to the depth (#1819, `updateAllUnits`):
 *
 *   - 'prompts' — stale visual/motion prompts only. Nothing renders.
 *   - 'images'  — + stale sheets, element references and stills — a still
 *                 whose prompt or sheet regenerates in this run too. Never
 *                 creates a FIRST sheet or still: that is a continue.
 *   - 'dialogue'— + dialogue audio: re-records a reading whose voice or
 *                 lines moved, and records a shot's FIRST reading once every
 *                 speaker has a voice (#1780 §6).
 *   - 'video'   — + videos: a shot whose motion prompt, still, or dialogue
 *                 changed in this run gets its video re-rendered. Never
 *                 renders a FIRST video.
 *   - 'music'   — + sequence music: a stale music prompt, then the track.
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
