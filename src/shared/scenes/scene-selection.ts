import type { ShotView } from '@/shared/shots/shot-view';
import { z } from 'zod';

/** URL-synced editor selection — empty means whole sequence. */
export type SceneSelection = {
  sceneIds: string[];
  shotId?: string;
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
  facet: z.enum(SCENE_FACETS).optional(),
  view: z.enum(CANVAS_VIEWS).optional(),
});

export type ScenesSearch = z.infer<typeof scenesSearchSchema>;

export function parseSelectionFromSearch(search: {
  scenes?: string;
  shot?: string;
}): SceneSelection {
  // Shot and scene selection are mutually exclusive; a URL carrying both
  // (hand-edited or stale link) normalizes to the shot so every consumer
  // sees the same state the transition functions produce.
  if (search.shot) {
    return { sceneIds: [], shotId: search.shot };
  }
  return {
    sceneIds: search.scenes
      ? search.scenes.split(',').filter((id) => id.length > 0)
      : [],
  };
}

export function selectionToSearchParams(
  selection: SceneSelection,
  facet?: SceneFacet,
  view?: CanvasView
): ScenesSearch {
  const params: ScenesSearch = {};
  if (selection.shotId) {
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
