/**
 * A scene's narrative (#1600): title, heading, time of day, story beat and
 * continuity tags. They live on the scene's selected script version with its
 * text, so every edit is a version.
 */

import type { SceneNarrative } from '@/platform/server/db/schema';
import { z } from 'zod';
import { plainSceneTitle } from '@/platform/markdown-plain';

export const sceneNarrativeOf = (scene: SceneNarrative): SceneNarrative => ({
  title: scene.title,
  location: scene.location,
  timeOfDay: scene.timeOfDay,
  storyBeat: scene.storyBeat,
  continuity: scene.continuity,
});

/**
 * Continuity as a key-order-free string, for comparing two narratives. The
 * look picks (#2015) are a nested map, which the key-list replacer below
 * would empty, so they are keyed on their own; no picks and no map at all
 * compare equal, since both mean "everyone in their default look".
 */
const continuityKey = (c: SceneNarrative['continuity']) => {
  if (!c) return null;
  const { characterLooks, ...tags } = c;
  const picks = Object.entries(characterLooks ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return (
    JSON.stringify(tags, Object.keys(tags).sort()) +
    (picks.length > 0 ? JSON.stringify(picks) : '')
  );
};

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

// Narrative edit input, shared by the editor (scenes.fn.ts) and MCP (#1459).

/** `''` / whitespace clears a nullable narrative field; otherwise trimmed. */
const narrativeField = z
  .string()
  .max(2000)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

/** Titles are labels: drop markdown sigils from the script editor. */
const sceneTitleField = z
  .string()
  .max(2000)
  .transform((v) => {
    const plain = plainSceneTitle(v);
    return plain.length > 0 ? plain : null;
  });

export const sceneNarrativeFieldsSchema = z.object({
  title: sceneTitleField.optional(),
  location: narrativeField.optional(),
  timeOfDay: narrativeField.optional(),
  storyBeat: narrativeField.optional(),
  continuity: z
    .object({
      characterTags: z.array(z.string().trim().max(200)).max(100).optional(),
      // The look each character wears in this scene (#2015): character tag
      // → look id. Sent whole: a character left out wears its default look.
      characterLooks: z
        .record(z.string().trim().max(200), z.string().trim().max(64))
        .optional(),
      environmentTag: z.string().trim().max(200).optional(),
      elementTags: z.array(z.string().trim().max(200)).max(100).optional(),
      lightingSetup: z.string().trim().max(2000).optional(),
      colorPalette: z.string().trim().max(2000).optional(),
    })
    .optional(),
});
