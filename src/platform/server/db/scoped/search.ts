/**
 * Global search (#2100): one substring query per kind of thing, team-scoped.
 *
 * The team boundary (pinned by `search.test.ts`): every query starts from a
 * row that carries the team, or joins the team's sequence. Version pointers
 * have no foreign key, so each version join also names its parent: a pointer
 * that strays to another team's version matches nothing.
 *
 * Reads only what is live and current: no archived sequences, no deleted
 * rows, and for versioned text only the selected version.
 *
 * ponytail: every query scans the team's rows (`instr` cannot use an index).
 * Move to FTS5 tables when a team's search gets slow.
 */

import {
  and,
  desc,
  eq,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import {
  characterBibleVersions,
  characterLooks,
  characterLookVersions,
  characters,
  framePromptVersions,
  frames,
  generatedAssets,
  locationBibleVersions,
  locations,
  scenes,
  sceneScriptVersions,
  sequenceLocationLinks,
  sequences,
  shotDialogueVersions,
  shotPromptVersions,
  shots,
  shotSpecVersions,
} from '@/platform/server/db/schema';
import { excerpt, type SearchHit, type SearchKind } from '@/platform/search';

type Text = string | null | undefined;

export function createSearchMethods(db: Database, teamId: string) {
  return {
    find: async (query: string, limit: number): Promise<SearchHit[]> => {
      // `instr`, not LIKE: D1 caps a LIKE pattern at 50 bytes, and `instr`
      // needs no wildcard escaping.
      const has = (text: AnyColumn | SQL) =>
        sql`instr(lower(${text}), lower(${query})) > 0`;
      const any = (texts: Record<string, AnyColumn | SQL>) =>
        or(...Object.values(texts).map(has));
      const hit = (
        kind: SearchKind,
        id: string,
        title: string,
        texts: readonly Text[],
        sequence: SearchHit['sequence'] = null
      ): SearchHit => ({
        kind,
        id,
        title,
        snippet: excerpt(texts, query),
        sequence,
      });

      const liveSequence = and(
        eq(sequences.teamId, teamId),
        ne(sequences.status, 'archived')
      );
      const sequenceRef = {
        sequenceId: sequences.id,
        sequenceTitle: sequences.title,
      };

      const sequenceTexts = {
        title: sequences.title,
        script: sequences.script,
      };
      const findSequences = db
        .select({ id: sequences.id, ...sequenceTexts })
        .from(sequences)
        .where(and(liveSequence, any(sequenceTexts)))
        .orderBy(desc(sequences.updatedAt))
        .limit(limit);

      const sceneTexts = {
        title: sceneScriptVersions.title,
        location: sceneScriptVersions.location,
        timeOfDay: sceneScriptVersions.timeOfDay,
        storyBeat: sceneScriptVersions.storyBeat,
        extract: sql<
          string | null
        >`json_extract(${sceneScriptVersions.content}, '$.extract')`,
      };
      const findScenes = db
        .select({
          id: scenes.id,
          orderIndex: scenes.orderIndex,
          ...sequenceRef,
          ...sceneTexts,
        })
        .from(scenes)
        .innerJoin(sequences, eq(sequences.id, scenes.sequenceId))
        .innerJoin(
          sceneScriptVersions,
          and(
            eq(sceneScriptVersions.id, scenes.selectedScriptVersionId),
            eq(sceneScriptVersions.sceneId, scenes.id)
          )
        )
        .where(and(liveSequence, isNull(scenes.deletedAt), any(sceneTexts)))
        .orderBy(desc(scenes.updatedAt))
        .limit(limit);

      const spec = (path: string) =>
        sql<string | null>`json_extract(${shotSpecVersions.spec}, ${path})`;
      const shotTexts = {
        action: spec('$.action'),
        direction: spec('$.direction'),
        soundCue: spec('$.soundCue'),
        imagePrompt: framePromptVersions.text,
        motionPrompt: shotPromptVersions.text,
      };
      // The lines a shot says are its selected dialogue version (#1657).
      // Rows from before it, whose lines live only on the motion prompt, are
      // not searched.
      const saysIt = sql`EXISTS (SELECT 1 FROM json_each(${shotDialogueVersions.lines}) WHERE ${has(sql`json_extract(value, '$.line')`)})`;
      const findShots = db
        .select({
          id: shots.id,
          shotNumber: shots.shotNumber,
          lines: shotDialogueVersions.lines,
          ...sequenceRef,
          ...shotTexts,
        })
        .from(shots)
        .innerJoin(sequences, eq(sequences.id, shots.sequenceId))
        .leftJoin(
          shotSpecVersions,
          and(
            eq(shotSpecVersions.id, shots.selectedSpecVersionId),
            eq(shotSpecVersions.shotId, shots.id)
          )
        )
        .leftJoin(
          shotPromptVersions,
          and(
            eq(shotPromptVersions.id, shots.selectedMotionPromptVersionId),
            eq(shotPromptVersions.shotId, shots.id)
          )
        )
        // The anchor frame, as `shot-view-query` joins it.
        .leftJoin(
          frames,
          and(
            eq(frames.shotId, shots.id),
            eq(frames.orderIndex, 0),
            eq(frames.sequenceId, shots.sequenceId)
          )
        )
        .leftJoin(
          framePromptVersions,
          and(
            eq(framePromptVersions.id, frames.selectedImagePromptVersionId),
            eq(framePromptVersions.frameId, frames.id)
          )
        )
        .leftJoin(
          shotDialogueVersions,
          and(
            eq(shotDialogueVersions.shotId, shots.id),
            sql`${shotDialogueVersions.selectedAt} IS NOT NULL`
          )
        )
        .where(
          and(liveSequence, isNull(shots.deletedAt), or(any(shotTexts), saysIt))
        )
        .orderBy(desc(shots.updatedAt))
        .limit(limit);

      // A default look's id is its character's id (#2015).
      const characterTexts = {
        name: characterBibleVersions.name,
        age: characterBibleVersions.age,
        gender: characterBibleVersions.gender,
        ethnicity: characterBibleVersions.ethnicity,
        physicalDescription: characterBibleVersions.physicalDescription,
        personality: characterBibleVersions.personality,
        movement: characterBibleVersions.movement,
        clothing: characterLookVersions.clothing,
        styling: characterLookVersions.styling,
      };
      const findCharacters = db
        .select({ id: characters.id, ...characterTexts })
        .from(characters)
        .innerJoin(
          characterBibleVersions,
          and(
            eq(characterBibleVersions.id, characters.selectedBibleVersionId),
            eq(characterBibleVersions.characterId, characters.id)
          )
        )
        .leftJoin(
          characterLooks,
          and(
            eq(characterLooks.id, characters.id),
            eq(characterLooks.characterId, characters.id)
          )
        )
        .leftJoin(
          characterLookVersions,
          and(
            eq(characterLookVersions.id, characterLooks.selectedLookVersionId),
            eq(characterLookVersions.lookId, characterLooks.id)
          )
        )
        .where(
          and(
            eq(characters.teamId, teamId),
            isNull(characters.deletedAt),
            any(characterTexts)
          )
        )
        .orderBy(desc(characters.updatedAt))
        .limit(limit);

      // A location with no bible version yet reads its own columns.
      const bible = (version: AnyColumn, own: AnyColumn) =>
        sql<
          string | null
        >`CASE WHEN ${locationBibleVersions.id} IS NULL THEN ${own} ELSE ${version} END`;
      const locationTexts = {
        name: bible(locationBibleVersions.name, locations.legacyName),
        type: bible(locationBibleVersions.type, locations.legacyType),
        description: bible(
          locationBibleVersions.description,
          locations.legacyDescription
        ),
        architecturalStyle: bible(
          locationBibleVersions.architecturalStyle,
          locations.legacyArchitecturalStyle
        ),
        keyFeatures: bible(
          locationBibleVersions.keyFeatures,
          locations.legacyKeyFeatures
        ),
        ambiance: bible(
          locationBibleVersions.ambiance,
          locations.legacyAmbiance
        ),
      };
      const locationBibleJoin = and(
        eq(locationBibleVersions.id, locations.selectedBibleVersionId),
        eq(locationBibleVersions.locationId, locations.id)
      );
      // One hit per live link, so the result opens that sequence's location.
      const findSequenceLocations = db
        .select({
          id: locations.id,
          ...sequenceRef,
          ...locationTexts,
        })
        .from(locations)
        .innerJoin(
          sequenceLocationLinks,
          and(
            eq(sequenceLocationLinks.locationId, locations.id),
            isNull(sequenceLocationLinks.removedAt)
          )
        )
        .innerJoin(
          sequences,
          eq(sequences.id, sequenceLocationLinks.sequenceId)
        )
        .leftJoin(locationBibleVersions, locationBibleJoin)
        .where(
          and(
            eq(locations.teamId, teamId),
            liveSequence,
            isNull(locations.deletedAt),
            any(locationTexts)
          )
        )
        .orderBy(desc(locations.updatedAt))
        .limit(limit);

      // A team location no sequence is using. A link to an archived sequence
      // still counts as in use, so that place stays out of this list.
      const findLibraryLocations = db
        .select({
          id: locations.id,
          name: sql<string>`coalesce(${locationBibleVersions.name}, ${locations.legacyName})`,
          description: locationTexts.description,
        })
        .from(locations)
        .leftJoin(locationBibleVersions, locationBibleJoin)
        .where(
          and(
            eq(locations.teamId, teamId),
            isNull(locations.deletedAt),
            any(locationTexts),
            notExists(
              db
                .select({ one: sql`1` })
                .from(sequenceLocationLinks)
                .where(
                  and(
                    eq(sequenceLocationLinks.locationId, locations.id),
                    isNull(sequenceLocationLinks.removedAt)
                  )
                )
            )
          )
        )
        .orderBy(desc(locations.updatedAt))
        .limit(limit);

      const prompt = sql<
        string | null
      >`json_extract(${generatedAssets.input}, '$.prompt')`;
      const findAssets = (activity: 'image' | 'video') =>
        db
          .select({ id: generatedAssets.id, prompt })
          .from(generatedAssets)
          .where(
            and(
              eq(generatedAssets.teamId, teamId),
              eq(generatedAssets.source, 'studio'),
              eq(generatedAssets.activity, activity),
              has(prompt)
            )
          )
          .orderBy(desc(generatedAssets.id))
          .limit(limit);

      const [
        sequenceRows,
        sceneRows,
        shotRows,
        characterRows,
        sequenceLocationRows,
        libraryLocationRows,
        imageRows,
        clipRows,
      ] = await Promise.all([
        findSequences,
        findScenes,
        findShots,
        findCharacters,
        findSequenceLocations,
        findLibraryLocations,
        findAssets('image'),
        findAssets('video'),
      ]);

      const inSequence = (row: {
        sequenceId: string;
        sequenceTitle: string;
      }) => ({ id: row.sequenceId, title: row.sequenceTitle });

      return [
        ...sequenceRows.map((row) =>
          hit('sequence', row.id, row.title, [row.script])
        ),
        ...sceneRows.map((row) =>
          hit(
            'scene',
            row.id,
            row.title || `Scene ${row.orderIndex + 1}`,
            [row.extract, row.storyBeat, row.location, row.timeOfDay],
            inSequence(row)
          )
        ),
        ...shotRows.map((row) =>
          hit(
            'shot',
            row.id,
            row.shotNumber === null ? 'Shot' : `Shot ${row.shotNumber}`,
            [
              ...(row.lines ?? []).map((line) => line.line),
              row.action,
              row.direction,
              row.soundCue,
              row.imagePrompt,
              row.motionPrompt,
            ],
            inSequence(row)
          )
        ),
        ...characterRows.map(({ id, name, ...texts }) =>
          hit('character', id, name, Object.values(texts))
        ),
        ...sequenceLocationRows.map(
          ({ id, name, sequenceId, sequenceTitle, ...texts }) =>
            hit(
              'sequenceLocation',
              id,
              name ?? 'Location',
              Object.values(texts),
              { id: sequenceId, title: sequenceTitle }
            )
        ),
        ...libraryLocationRows.map((row) =>
          hit('libraryLocation', row.id, row.name, [row.description])
        ),
        ...imageRows.map((row) => hit('image', row.id, 'Image', [row.prompt])),
        ...clipRows.map((row) => hit('clip', row.id, 'Clip', [row.prompt])),
      ];
    },
  };
}
