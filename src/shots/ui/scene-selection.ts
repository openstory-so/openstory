import type { ShotView } from '@/shots/shot-view';
import { z } from 'zod';

/**
 * How the canvas plays while a shot is current (#1771).
 * `continue` keeps the sequence (or scene-range) player mounted and treats
 * `shotId` as the playhead. `shot` plays only that shot.
 * Omitted: a shot id means `shot`, otherwise `continue`.
 */
export type PlaybackMode = 'continue' | 'shot';

/** URL-synced editor selection — empty means whole sequence. */
export type SceneSelection = {
  sceneIds: string[];
  shotId?: string;
  playback?: PlaybackMode;
};

export type SelectionScope = 'sequence' | 'scenes' | 'shot';

/**
 * The inspector facets/tabs — one shared token set, so the URL `facet` param
 * and the inspector's tab values never drift apart.
 */
export const SCENE_FACETS = [
  'cast',
  'location',
  'elements',
  'music',
  'script',
  'scene-variants',
  'image-prompt',
  'motion-prompt',
] as const;

export type SceneFacet = (typeof SCENE_FACETS)[number];

/**
 * What the centre column shows. `canvas` is the player/frame preview; `script`
 * is the scene-block document — the whole script, read top-to-bottom, editable
 * a scene at a time. Both rails (spine, inspector) and the selection are shared,
 * so this is a view of the same object rather than a different page.
 */
const CANVAS_VIEWS = ['canvas', 'script'] as const;
export type CanvasView = (typeof CANVAS_VIEWS)[number];
export const DEFAULT_CANVAS_VIEW: CanvasView = 'canvas';

export const scenesSearchSchema = z.object({
  scenes: z.string().optional(),
  shot: z.string().optional(),
  /** Set when a shot id is the playhead of a sequence/scene play, not a single-shot player. */
  playback: z.enum(['continue', 'shot']).optional(),
  facet: z.enum(SCENE_FACETS).optional(),
  view: z.enum(CANVAS_VIEWS).optional(),
});

export type ScenesSearch = z.infer<typeof scenesSearchSchema>;

function sceneIdsFromSearch(scenes: string | undefined): string[] {
  return scenes ? scenes.split(',').filter((id) => id.length > 0) : [];
}

export function parseSelectionFromSearch(search: {
  scenes?: string;
  shot?: string;
  playback?: PlaybackMode;
}): SceneSelection {
  // Continue keeps the scene range AND the playhead shot. Any other URL
  // that carries both (hand-edited or stale) normalizes to the shot.
  if (search.playback === 'continue') {
    return {
      sceneIds: sceneIdsFromSearch(search.scenes),
      shotId: search.shot,
      playback: 'continue',
    };
  }
  if (search.shot) {
    return { sceneIds: [], shotId: search.shot, playback: 'shot' };
  }
  return { sceneIds: sceneIdsFromSearch(search.scenes) };
}

export function playbackMode(selection: SceneSelection): PlaybackMode {
  if (selection.playback) return selection.playback;
  return selection.shotId ? 'shot' : 'continue';
}

export function selectionToSearchParams(
  selection: SceneSelection,
  facet?: SceneFacet,
  view?: CanvasView
): ScenesSearch {
  const params: ScenesSearch = {};
  const mode = playbackMode(selection);
  if (mode === 'continue') {
    if (selection.sceneIds.length > 0) {
      params.scenes = selection.sceneIds.join(',');
    }
    if (selection.shotId) {
      params.shot = selection.shotId;
      params.playback = 'continue';
    }
  } else if (selection.shotId) {
    params.shot = selection.shotId;
  } else if (selection.sceneIds.length > 0) {
    params.scenes = selection.sceneIds.join(',');
  }
  if (facet) params.facet = facet;
  // The default view stays out of the URL so a plain /scenes link is canonical.
  if (view && view !== DEFAULT_CANVAS_VIEW) params.view = view;
  return params;
}

export function selectionScope(selection: SceneSelection): SelectionScope {
  if (selection.shotId) return 'shot';
  if (selection.sceneIds.length > 0) return 'scenes';
  return 'sequence';
}

export function selectionShots(
  selection: SceneSelection,
  shots: ShotView[]
): ShotView[] {
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    return shot ? [shot] : [];
  }
  if (selection.sceneIds.length > 0) {
    const sceneIdSet = new Set(selection.sceneIds);
    return shots.filter((s) => s.sceneId != null && sceneIdSet.has(s.sceneId));
  }
  return shots;
}

/**
 * Shots the canvas player should stitch. Continue ignores the playhead shot
 * so selecting it does not swap the sequence player for a single shot.
 */
export function playbackRangeShots<
  S extends { id: string; sceneId: string | null },
>(selection: SceneSelection, shots: readonly S[]): S[] {
  if (playbackMode(selection) === 'shot') {
    if (!selection.shotId) return [];
    const shot = shots.find((item) => item.id === selection.shotId);
    return shot ? [shot] : [];
  }
  if (selection.sceneIds.length > 0) {
    const sceneIdSet = new Set(selection.sceneIds);
    return shots.filter(
      (item) => item.sceneId != null && sceneIdSet.has(item.sceneId)
    );
  }
  return shots.slice();
}

export function toggleSceneInSelection(
  selection: SceneSelection,
  sceneId: string,
  additive: boolean
): SceneSelection {
  if (selection.shotId) {
    return additive
      ? { sceneIds: [sceneId], shotId: undefined }
      : { sceneIds: [sceneId] };
  }
  const has = selection.sceneIds.includes(sceneId);
  if (additive) {
    return {
      sceneIds: has
        ? selection.sceneIds.filter((id) => id !== sceneId)
        : [...selection.sceneIds, sceneId],
    };
  }
  return has && selection.sceneIds.length === 1
    ? { sceneIds: [] }
    : { sceneIds: [sceneId] };
}

/**
 * Select exactly one scene, idempotently.
 *
 * Distinct from {@link toggleSceneInSelection}, whose non-additive branch
 * deselects a scene that is already the sole selection — right for the spine,
 * where a click is a toggle, but wrong wherever selection follows focus: the
 * script document re-fires selection whenever focus re-enters a block (e.g.
 * after its Save button unmounts), and a toggle there would clear the very
 * scene the user is editing.
 */
export function selectScene(sceneId: string): SceneSelection {
  return { sceneIds: [sceneId] };
}

export function selectShot(shotId: string): SceneSelection {
  return { sceneIds: [], shotId };
}

export function clearSelection(): SceneSelection {
  return { sceneIds: [] };
}

/**
 * Walk up one selection level: shot → parent scene → whole sequence.
 * Returns `null` when already at sequence (nothing to ascend). Used by Escape.
 */
export function ascendSelection(
  selection: SceneSelection,
  shots: ReadonlyArray<{ id: string; sceneId: string | null }>
): SceneSelection | null {
  // Playhead follow: Esc clears the cursor and leaves the sequence player
  // on the same range. A single-shot player still walks shot → scene.
  if (selection.shotId && playbackMode(selection) === 'continue') {
    return { sceneIds: selection.sceneIds, playback: 'continue' };
  }
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    const sceneId = shot?.sceneId;
    if (sceneId) return { sceneIds: [sceneId] };
    return clearSelection();
  }
  if (selection.sceneIds.length > 0) {
    return clearSelection();
  }
  return null;
}
