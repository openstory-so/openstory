/**
 * Bible entry → DB row for the cast, locations and script-detected elements.
 *
 * The Script stage creates every row WITHOUT a sheet (`pending`, no image)
 * so a run stopped there shows the whole bible for review before a single
 * reference image is billed. The References stage re-upserts the same rows
 * (`generating`) and fills the sheets in — the (sequenceId, bibleId) upsert
 * keys keep the ids stable across the two stages.
 */

import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type {
  NewCharacter,
  ReferenceStatus,
  SequenceElementMinimal,
  SheetStatus,
} from '@/platform/server/db/schema';
import type { AnalysedLocation } from '@/cast/server/db/locations';
import { withBibleLooks } from '@/cast/bible-looks';
import type {
  AttachedCastSnapshot,
  ElementSheetEntry,
  LibraryLocationMatch,
} from '@/platform/server/workflow/types';

export function buildCharacterInsert(args: {
  sequenceId: string;
  character: CharacterBibleEntry;
  sheetStatus: SheetStatus;
}): NewCharacter {
  const { sequenceId, character, sheetStatus } = args;
  return {
    id: generateId(),
    sequenceId,
    characterId: character.characterId,
    name: character.name,
    age: character.age,
    gender: character.gender,
    ethnicity: character.ethnicity,
    physicalDescription: character.physicalDescription,
    standardClothing: character.standardClothing,
    personality: character.personality,
    movement: character.movement,
    voiceOnly: character.voiceOnly,
    rendering: character.voiceOnly ? null : character.rendering,
    // What the script says. For a character that already exists the write
    // keeps a person a person whatever this says (`characters.create`, #2065).
    isPerson: character.isPerson,
    consistencyTag: character.consistencyTag,
    voiceId: null,
    voiceDescription: character.voiceDescription.trim() || null,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    sheetStatus,
  };
}

/**
 * One analysed location. A script location matching bound to one of the
 * team's (`libraryMatch`, #1695) is linked to it (`boundTo`): no location is
 * made and the bible analysis wrote for it is dropped.
 */
export function buildLocationInsert(args: {
  sequenceId: string;
  location: LocationBibleEntry;
  libraryMatch: LibraryLocationMatch | undefined;
  referenceStatus: ReferenceStatus;
}): AnalysedLocation {
  const { sequenceId, location, libraryMatch, referenceStatus } = args;
  return {
    id: generateId(),
    sequenceId,
    locationId: location.locationId,
    name: location.name,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    type: location.type ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    description: location.description ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    architecturalStyle: location.architecturalStyle ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    keyFeatures: location.keyFeatures ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    ambiance: location.ambiance ?? null,
    rendering: location.rendering,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    consistencyTag: location.consistencyTag ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionSceneId: location.firstMention?.sceneId ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionText: location.firstMention?.text ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionLine: location.firstMention?.lineNumber ?? null,
    referenceStatus,
    boundTo: libraryMatch?.libraryLocationId ?? null,
  };
}

/**
 * Upper bound on auto-generated element references per run. The scene-split
 * prompt asks the model to detect at most 3; this guards against a chatty
 * model burning image credits on incidental props.
 */
export const MAX_AUTO_ELEMENTS = 3;

/**
 * Element bible entries that still need a reference image: no row for the
 * token, or a row the Script stage created without one. Uploaded elements
 * always win — the bible echoes their tokens back. The existing row's id is
 * reused so the References stage fills in the same row the user has been
 * looking at.
 *
 * Capped here, where the placeholder rows, the billing count and the sheet
 * spawn all read from, so an entry past the cap never gets a row that would
 * sit image-less forever and re-count as missing on every run.
 */
export function findMissingElementEntries(
  elementBible: ElementBibleEntry[],
  existing: Array<Pick<SequenceElementMinimal, 'id' | 'token' | 'imageUrl'>>
): ElementSheetEntry[] {
  const byToken = new Map(existing.map((el) => [el.token, el]));
  return elementBible
    .flatMap((entry) => {
      const row = byToken.get(entry.token);
      if (row?.imageUrl) return [];
      return [{ ...entry, elementId: row?.id ?? generateId() }];
    })
    .slice(0, MAX_AUTO_ELEMENTS);
}

/**
 * Create the cast, location and element rows for a sequence, sheet-less.
 * Idempotent: characters and locations upsert on their bible id; elements
 * are guarded by a token lookup (a step retry must not trip the unique
 * (sequenceId, token) index).
 */
export async function createCastRecords(
  scopedDb: WorkflowScopedDb,
  args: {
    sequenceId: string;
    /** The trigger's cast snapshot (#2050): which entries are shared characters. */
    cast: readonly AttachedCastSnapshot[];
    characterBible: CharacterBibleEntry[];
    locationBible: LocationBibleEntry[];
    locationMatches: LibraryLocationMatch[];
    elementBible: ElementBibleEntry[];
    existingElements: Array<
      Pick<SequenceElementMinimal, 'id' | 'token' | 'imageUrl'>
    >;
  }
): Promise<{
  elements: SequenceElementMinimal[];
  /** Each bible look id → the `character_looks.id` it landed on (#2015). */
  lookIds: Record<string, string>;
}> {
  const { sequenceId } = args;
  const sharedById = new Map(
    args.cast.filter((c) => c.shared).map((c) => [c.entry.characterId, c.id])
  );
  const lookIds: Record<string, string> = {};
  for (const character of args.characterBible) {
    // A character the library or another sequence holds (#2050) is linked,
    // never rewritten: no bible version, no look edit, no look removed. Her
    // looks are matched by name and a new one is added for a name she lacks.
    const sharedId = sharedById.get(character.characterId);
    if (sharedId) {
      if (character.voiceOnly) continue;
      Object.assign(
        lookIds,
        await scopedDb.characterLooks.linkFromAnalysis(
          sequenceId,
          sharedId,
          withBibleLooks(character).looks
        )
      );
      continue;
    }
    const created = await scopedDb.characters.create(
      buildCharacterInsert({
        sequenceId,
        character,
        sheetStatus: 'pending',
      }),
      { source: 'analysis', createdBy: null }
    );
    // A voice-only character is never seen, so it wears nothing to track.
    if (character.voiceOnly) continue;
    Object.assign(
      lookIds,
      await scopedDb.characterLooks.syncFromAnalysis(
        sequenceId,
        created.id,
        withBibleLooks(character).looks
      )
    );
  }

  const libraryByLocation = new Map(
    args.locationMatches.map((m) => [m.locationId, m])
  );
  await scopedDb.locations.createBulk(
    args.locationBible.map((location) =>
      buildLocationInsert({
        sequenceId,
        location,
        libraryMatch: libraryByLocation.get(location.locationId),
        referenceStatus: 'pending',
      })
    ),
    { source: 'analysis', createdBy: null }
  );

  const elements: SequenceElementMinimal[] = [];
  for (const entry of findMissingElementEntries(
    args.elementBible,
    args.existingElements
  )) {
    const raced = await scopedDb.liveRead.sequenceElements.getByToken(
      sequenceId,
      entry.token
    );
    const row =
      raced ??
      (await scopedDb.sequenceElements.create({
        id: entry.elementId,
        sequenceId,
        uploadedFilename: `generated-${entry.token.toLowerCase()}.png`,
        token: entry.token,
        imageUrl: null,
        imagePath: null,
        // The bible entry already carries what vision would produce.
        description: entry.description,
        consistencyTag: entry.consistencyTag,
        visionStatus: 'completed',
        visionGeneratedAt: new Date(),
        firstMentionSceneId: entry.firstMention.sceneId,
        firstMentionText: entry.firstMention.text,
        firstMentionLine: entry.firstMention.lineNumber,
      }));
    elements.push({
      id: row.id,
      token: row.token,
      description: row.description,
      imageUrl: row.imageUrl,
      consistencyTag: row.consistencyTag,
      kind: row.kind,
      durationSeconds: row.durationSeconds,
    });
  }
  return { elements, lookIds };
}
