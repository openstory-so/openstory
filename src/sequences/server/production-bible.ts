/**
 * The production bible (#1462): one read of what an agent needs before it
 * writes — style, cast, locations, elements and each scene's selected
 * narrative with a script excerpt. Composed from existing records; nothing is
 * persisted. Every list is capped, and a cap that bites is marked with the
 * tool that pages the rest, so nothing is cut silently.
 */

import { z } from 'zod';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { SceneScriptVersion } from '@/platform/server/db/schema';
import {
  characterReadSchema,
  elementReadSchema,
  listCharacters,
  listElements,
  listLocations,
  locationReadSchema,
} from '@/cast/server/production-inspection';
import { productionAccess } from './production-access';

/** Characters, locations and elements per bible (each pages via its list tool). */
const BIBLE_ENTITY_LIMIT = 50;
/** Scenes per bible; the rest via list_scenes. */
export const BIBLE_SCENE_LIMIT = 100;
/** Characters of script text per scene excerpt; the whole scene via get_scene. */
export const BIBLE_EXCERPT_CHARS = 400;

type BibleScene = {
  sceneId: string;
  orderIndex: number;
  version: SceneScriptVersion;
};

/** Pure: the bible's scene list, capped and with explicit truncation. */
export function bibleScenes(rows: readonly BibleScene[]) {
  return {
    scenes: rows
      .slice(0, BIBLE_SCENE_LIMIT)
      .map(({ sceneId, orderIndex, version }) => {
        const extract = version.content.extract;
        return {
          sceneId,
          orderIndex,
          selectedScriptVersionId: version.id,
          title: version.title,
          location: version.location,
          timeOfDay: version.timeOfDay,
          storyBeat: version.storyBeat,
          continuity: version.continuity,
          scriptExcerpt: extract.slice(0, BIBLE_EXCERPT_CHARS),
          scriptExcerptTruncated: extract.length > BIBLE_EXCERPT_CHARS,
        };
      }),
    totalScenes: rows.length,
    scenesTruncated:
      rows.length > BIBLE_SCENE_LIMIT
        ? { continueWith: 'list_scenes' as const }
        : null,
  };
}

const truncationSchema = z
  .object({ continueWith: z.string(), cursor: z.string().optional() })
  .nullable();

export const productionBibleSchema = z.object({
  sequenceId: z.string(),
  title: z.string(),
  aspectRatio: z.string(),
  style: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
    })
    .nullable(),
  characters: z.array(characterReadSchema),
  charactersTruncated: truncationSchema,
  locations: z.array(locationReadSchema),
  locationsTruncated: truncationSchema,
  elements: z.array(elementReadSchema),
  elementsTruncated: truncationSchema,
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      orderIndex: z.number(),
      selectedScriptVersionId: z.string(),
      title: z.string().nullable(),
      location: z.string().nullable(),
      timeOfDay: z.string().nullable(),
      storyBeat: z.string().nullable(),
      continuity: z.record(z.string(), z.unknown()).nullable(),
      scriptExcerpt: z.string(),
      scriptExcerptTruncated: z.boolean(),
    })
  ),
  totalScenes: z.number(),
  scenesTruncated: truncationSchema,
  limits: z.object({
    entities: z.number(),
    scenes: z.number(),
    excerptChars: z.number(),
  }),
});

const truncation = (nextCursor: string | null, tool: string) =>
  nextCursor ? { continueWith: tool, cursor: nextCursor } : null;

export async function readProductionBible(
  scopedDb: ScopedDb,
  sequenceId: string,
  origin: string
) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const page = { sequenceId: sequence.id, limit: BIBLE_ENTITY_LIMIT };
  const [style, characters, locations, elements, scripts] = await Promise.all([
    scopedDb.styles.getById(sequence.styleId),
    listCharacters(scopedDb, page, origin),
    listLocations(scopedDb, page, origin),
    listElements(scopedDb, page, origin),
    scopedDb.sceneScriptVersions.listSelectedBySequence(sequence.id),
  ]);
  return {
    sequenceId: sequence.id,
    title: sequence.title,
    aspectRatio: sequence.aspectRatio,
    style: style
      ? { id: style.id, name: style.name, description: style.description }
      : null,
    characters: characters.characters,
    charactersTruncated: truncation(characters.nextCursor, 'list_characters'),
    locations: locations.locations,
    locationsTruncated: truncation(locations.nextCursor, 'list_locations'),
    elements: elements.elements,
    elementsTruncated: truncation(elements.nextCursor, 'list_elements'),
    ...bibleScenes(scripts),
    limits: {
      entities: BIBLE_ENTITY_LIMIT,
      scenes: BIBLE_SCENE_LIMIT,
      excerptChars: BIBLE_EXCERPT_CHARS,
    },
  };
}
