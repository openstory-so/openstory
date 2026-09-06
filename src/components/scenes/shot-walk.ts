/** Linear walk over shots for the mobile prev/next + swipe control. */

export type ShotWalkHit = { type: 'sequence' } | { type: 'shot'; id: string };

export type ShotWalkSelection = {
  shotId?: string;
  sceneIds: readonly string[];
};

type WalkShot = {
  id: string;
  sceneId: string | null;
};

/**
 * Next/previous shot in sequence order.
 *
 * Sequence scope sits *before* the first shot: next enters shot 0, prev is a
 * no-op. From a selected scene (no shot), next enters that scene's first shot
 * and prev goes to the shot before the scene (or sequence).
 */
export function adjacentShotId(
  shots: readonly WalkShot[],
  selection: ShotWalkSelection,
  delta: -1 | 1
): ShotWalkHit | null {
  const firstShot = shots[0];
  if (!firstShot) return null;

  if (selection.shotId) {
    const i = shots.findIndex((s) => s.id === selection.shotId);
    if (i < 0) return delta === 1 ? { type: 'shot', id: firstShot.id } : null;
    const next = shots[i + delta];
    if (i + delta < 0) return { type: 'sequence' };
    if (!next) return null;
    return { type: 'shot', id: next.id };
  }

  if (selection.sceneIds.length === 1) {
    const sceneId = selection.sceneIds[0];
    const first = shots.findIndex((s) => s.sceneId === sceneId);
    if (first < 0) return null;
    const sceneFirst = shots[first];
    if (!sceneFirst) return null;
    if (delta === 1) return { type: 'shot', id: sceneFirst.id };
    if (first === 0) return { type: 'sequence' };
    const prev = shots[first - 1];
    return prev ? { type: 'shot', id: prev.id } : null;
  }

  if (delta === 1) return { type: 'shot', id: firstShot.id };
  return null;
}
