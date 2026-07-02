/**
 * Selection model for the unified Scenes editor (#986).
 *
 * Selection IS the scope control: nothing selected = whole sequence,
 * scene(s) selected = those scenes, a shot selected = just that shot.
 * The selection lives in the route's search params so back/forward and
 * shared links restore it; everything here is a pure derivation over the
 * already-fetched shots list — no new queries.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';

/** Search-param shape: empty = whole sequence. `shotId` wins over `sceneIds`. */
export type SceneSelection = {
  sceneIds: string[];
  shotId?: string;
};

export type SelectionScope = 'sequence' | 'scene' | 'shot';

/**
 * The continuity tag sets a selection resolves to, feeding the inspector
 * facets. `scriptExtracts` carries the covered shots' original script slices
 * for element matching and the Script facet.
 */
export type SelectionTags = {
  characterTags: string[];
  environmentTags: string[];
  elementTags: string[];
  scriptExtracts: string[];
};

/** Minimal structural shot shape so the derivations stay pure and testable. */
export type SelectableShot = {
  id: string;
  sceneId: string | null;
  orderIndex: number;
  metadata: Scene | null;
};

export const EMPTY_SELECTION: SceneSelection = { sceneIds: [] };

export function scopeOf(selection: SceneSelection): SelectionScope {
  if (selection.shotId) return 'shot';
  if (selection.sceneIds.length > 0) return 'scene';
  return 'sequence';
}

function isSelectionEmpty(selection: SceneSelection): boolean {
  return scopeOf(selection) === 'sequence';
}

/**
 * Shots covered by the selection, in playback order. Sequence scope = all
 * shots; scene scope = shots of the selected scenes; shot scope = that shot.
 */
export function shotsInSelection<T extends SelectableShot>(
  selection: SceneSelection,
  shots: T[]
): T[] {
  const ordered = [...shots].sort((a, b) => a.orderIndex - b.orderIndex);
  if (selection.shotId) {
    return ordered.filter((s) => s.id === selection.shotId);
  }
  if (selection.sceneIds.length > 0) {
    const sceneSet = new Set(selection.sceneIds);
    return ordered.filter((s) => s.sceneId && sceneSet.has(s.sceneId));
  }
  return ordered;
}

function dedupe(values: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (v) set.add(v);
  }
  return [...set];
}

/**
 * The uniform selection rule (#986): `null` means "no filter" — facets show
 * everything at sequence scope. Scene scope unions tags across every covered
 * shot; shot scope is that shot's own tags (today's behaviour).
 */
export function selectionTags(
  selection: SceneSelection,
  shots: SelectableShot[]
): SelectionTags | null {
  if (isSelectionEmpty(selection)) return null;
  const covered = shotsInSelection(selection, shots);
  return {
    characterTags: dedupe(
      covered.flatMap((s) => s.metadata?.continuity?.characterTags ?? [])
    ),
    environmentTags: dedupe(
      covered.flatMap((s) => [
        s.metadata?.continuity?.environmentTag,
        s.metadata?.metadata?.location,
      ])
    ),
    elementTags: dedupe(
      covered.flatMap((s) => s.metadata?.continuity?.elementTags ?? [])
    ),
    scriptExtracts: dedupe(
      covered.map((s) => s.metadata?.originalScript.extract)
    ),
  };
}

// ---------------------------------------------------------------------------
// Selection transitions (spine clicks + keyboard grammar)
// ---------------------------------------------------------------------------

/** Ordered distinct scene ids as they appear across the ordered shots. */
export function orderedSceneIds(shots: SelectableShot[]): string[] {
  const ordered = [...shots].sort((a, b) => a.orderIndex - b.orderIndex);
  return dedupe(ordered.map((s) => s.sceneId));
}

/** Plain click on a scene header: select exactly that scene. */
export function selectScene(sceneId: string): SceneSelection {
  return { sceneIds: [sceneId] };
}

/** Plain click on a shot card: select exactly that shot. */
export function selectShot(shotId: string): SceneSelection {
  return { sceneIds: [], shotId };
}

/** Cmd/ctrl-click on a scene header: toggle it in the multi-selection. */
export function toggleScene(
  selection: SceneSelection,
  sceneId: string
): SceneSelection {
  const next = selection.sceneIds.includes(sceneId)
    ? selection.sceneIds.filter((id) => id !== sceneId)
    : [...selection.sceneIds, sceneId];
  return { sceneIds: next };
}

/**
 * Shift-click on a scene header: contiguous range from the selection's anchor
 * (its first scene) to the target, in spine order. With no anchor this is a
 * plain scene selection.
 */
export function rangeSelectScenes(
  selection: SceneSelection,
  sceneId: string,
  shots: SelectableShot[]
): SceneSelection {
  const order = orderedSceneIds(shots);
  const anchor = selection.sceneIds[0];
  const anchorIdx = anchor ? order.indexOf(anchor) : -1;
  const targetIdx = order.indexOf(sceneId);
  if (anchorIdx === -1 || targetIdx === -1) return selectScene(sceneId);
  const [from, to] =
    anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  return { sceneIds: order.slice(from, to + 1) };
}

/**
 * Esc zooms out one scope level: shot → its scene, scene(s) → sequence.
 * Already at sequence scope it's a no-op.
 */
export function zoomOut(
  selection: SceneSelection,
  shots: SelectableShot[]
): SceneSelection {
  if (selection.shotId) {
    const shot = shots.find((s) => s.id === selection.shotId);
    return shot?.sceneId ? selectScene(shot.sceneId) : EMPTY_SELECTION;
  }
  return EMPTY_SELECTION;
}

/**
 * ↑/↓: step the shot selection through the flat playback order, crossing
 * scene boundaries. From scene/sequence scope, ↓ enters the first covered
 * shot and ↑ the last, so the keys always land somewhere useful.
 */
export function stepShot(
  selection: SceneSelection,
  shots: SelectableShot[],
  direction: 1 | -1
): SceneSelection {
  const ordered = [...shots].sort((a, b) => a.orderIndex - b.orderIndex);
  if (ordered.length === 0) return selection;
  if (!selection.shotId) {
    const covered = shotsInSelection(selection, ordered);
    const pool = covered.length > 0 ? covered : ordered;
    const entry = direction === 1 ? pool[0] : pool[pool.length - 1];
    return entry ? selectShot(entry.id) : selection;
  }
  const idx = ordered.findIndex((s) => s.id === selection.shotId);
  if (idx === -1) return selection;
  const next =
    ordered[Math.min(ordered.length - 1, Math.max(0, idx + direction))];
  return next ? selectShot(next.id) : selection;
}

/**
 * ←/→: step the selection scene-wise. From shot scope, steps to the
 * neighbouring scene of the shot's scene; from sequence scope selects the
 * first/last scene.
 */
export function stepScene(
  selection: SceneSelection,
  shots: SelectableShot[],
  direction: 1 | -1
): SceneSelection {
  const order = orderedSceneIds(shots);
  if (order.length === 0) return selection;
  const currentSceneId = selection.shotId
    ? (shots.find((s) => s.id === selection.shotId)?.sceneId ?? undefined)
    : selection.sceneIds[selection.sceneIds.length - 1];
  if (!currentSceneId) {
    const entry = direction === 1 ? order[0] : order[order.length - 1];
    return entry ? selectScene(entry) : selection;
  }
  const idx = order.indexOf(currentSceneId);
  if (idx === -1) return selection;
  const next = order[Math.min(order.length - 1, Math.max(0, idx + direction))];
  return next ? selectScene(next) : selection;
}

/**
 * Shift+↑/↓ at scene scope: grow/shrink the contiguous scene range at its
 * trailing edge (Linear-style range extension).
 */
export function extendSceneRange(
  selection: SceneSelection,
  shots: SelectableShot[],
  direction: 1 | -1
): SceneSelection {
  const order = orderedSceneIds(shots);
  if (selection.sceneIds.length === 0) return selection;
  const last = selection.sceneIds[selection.sceneIds.length - 1];
  const lastIdx = last ? order.indexOf(last) : -1;
  if (lastIdx === -1) return selection;
  const targetIdx = lastIdx + direction;
  if (targetIdx < 0 || targetIdx >= order.length) return selection;
  const target = order[targetIdx];
  if (!target) return selection;
  if (selection.sceneIds.includes(target)) {
    // Shrinking back over an already-selected scene.
    return { sceneIds: selection.sceneIds.filter((id) => id !== last) };
  }
  return { sceneIds: [...selection.sceneIds, target] };
}
