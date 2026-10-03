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

/**
 * [entities per kind, scenes] tried in order until the bible fits
 * BIBLE_BYTES. Entities are re-read at each rung, so their cursors stay real.
 * ponytail: a fixed ladder; a byte-packing pass if bibles hit the last rung.
 */
const BIBLE_LADDER = [
  [50, 100],
  [20, 40],
  [5, 10],
] as const;
/** The last rung, returned as is: still over means a huge style or continuity. */
const BIBLE_FLOOR = [1, 2] as const;
/**
 * A tool result carries the bible twice (structured + JSON text) under one
 * 256 KiB cap, so the bible itself must stay under half, with envelope room.
 */
const BIBLE_BYTES = 120 * 1024;
/** Characters of script text per scene excerpt; the whole scene via get_scene. */
export const BIBLE_EXCERPT_CHARS = 400;

type BibleScene = {
  sceneId: string;
  orderIndex: number;
  version: SceneScriptVersion;
};

/** Pure: the bible's scene list, capped and with explicit truncation. */
export function bibleScenes(rows: readonly BibleScene[], limit: number) {
  return {
    scenes: rows.slice(0, limit).map(({ sceneId, orderIndex, version }) => {
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
      rows.length > limit ? { continueWith: 'list_scenes' as const } : null,
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
});

const truncation = (nextCursor: string | null, tool: string) =>
  nextCursor ? { continueWith: tool, cursor: nextCursor } : null;

export async function readProductionBible(
  scopedDb: ScopedDb,
  sequenceId: string,
  origin: string
) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const [style, scripts] = await Promise.all([
    scopedDb.styles.getById(sequence.styleId),
    scopedDb.sceneScriptVersions.listSelectedBySequence(sequence.id),
  ]);
  const build = async (entityLimit: number, sceneLimit: number) => {
    const page = { sequenceId: sequence.id, limit: entityLimit };
    const [characters, locations, elements] = await Promise.all([
      listCharacters(scopedDb, page, origin),
      listLocations(scopedDb, page, origin),
      listElements(scopedDb, page, origin),
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
      ...bibleScenes(scripts, sceneLimit),
    };
  };
  for (const [entityLimit, sceneLimit] of BIBLE_LADDER) {
    const bible = await build(entityLimit, sceneLimit);
    if (new TextEncoder().encode(JSON.stringify(bible)).length <= BIBLE_BYTES) {
      return bible;
    }
  }
  // The caller's 256 KiB cap refuses an over-size floor; nothing is cut.
  return build(...BIBLE_FLOOR);
}
