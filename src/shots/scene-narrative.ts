/**
 * A scene's narrative (#1600): title, heading, time of day, story beat and
 * continuity tags. They live on the scene's selected script version with its
 * text, so every edit is a version.
 */

import type { SceneNarrative } from '@/platform/server/db/schema';

export const sceneNarrativeOf = (scene: SceneNarrative): SceneNarrative => ({
  title: scene.title,
  location: scene.location,
  timeOfDay: scene.timeOfDay,
  storyBeat: scene.storyBeat,
  continuity: scene.continuity,
});

/** Continuity as a key-order-free string, for comparing two narratives. */
const continuityKey = (c: SceneNarrative['continuity']) =>
  c ? JSON.stringify(c, Object.keys(c).sort()) : null;

/** The narrative fields that differ between two versions of a scene. */
export function narrativeFieldsChanged(
  before: SceneNarrative,
  after: SceneNarrative
): (keyof SceneNarrative)[] {
  const changed: (keyof SceneNarrative)[] = [];
  for (const key of ['title', 'location', 'timeOfDay', 'storyBeat'] as const) {
    if ((before[key] ?? null) !== (after[key] ?? null)) changed.push(key);
  }
  if (continuityKey(before.continuity) !== continuityKey(after.continuity)) {
    changed.push('continuity');
  }
  return changed;
}
