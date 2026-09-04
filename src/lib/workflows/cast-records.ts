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
} from '@/lib/ai/scene-analysis.schema';
import { generateId } from '@/shared/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type {
  NewCharacter,
  NewSequenceLocation,
  SequenceElementMinimal,
  SheetStatus,
} from '@/lib/db/schema';
import type { ReferenceStatus } from '@/lib/db/schema/sequence-locations';
import { buildCastingAttributes } from '@/lib/prompts/character-prompt';
import type {
  ElementSheetEntry,
  LibraryLocationMatch,
  TalentCharacterMatch,
} from '@/lib/workflow/types';

export function buildCharacterInsert(args: {
  sequenceId: string;
  character: CharacterBibleEntry;
  talentMatch: TalentCharacterMatch | undefined;
  sheetStatus: SheetStatus;
}): NewCharacter {
  const { sequenceId, character, talentMatch, sheetStatus } = args;
  const castingAttrs = talentMatch
    ? buildCastingAttributes(character, {
        sheetMetadata: talentMatch.sheetMetadata,
        talentName: talentMatch.talentName,
      })
    : null;
  return {
    id: generateId(),
    sequenceId,
    characterId: character.characterId,
    name: character.name,
    age: castingAttrs?.age ?? character.age,
    gender: castingAttrs?.gender ?? character.gender,
    ethnicity: castingAttrs?.ethnicity ?? character.ethnicity,
    physicalDescription:
      castingAttrs?.physicalDescription ?? character.physicalDescription,
    standardClothing: character.standardClothing,
    distinguishingFeatures: character.distinguishingFeatures,
    consistencyTag: castingAttrs?.consistencyTag ?? character.consistencyTag,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    sheetStatus,
    talentId: talentMatch?.talentId ?? null,
  };
}

export function buildLocationInsert(args: {
  sequenceId: string;
  location: LocationBibleEntry;
  libraryMatch: LibraryLocationMatch | undefined;
  referenceStatus: ReferenceStatus;
}): NewSequenceLocation {
  const { sequenceId, location, libraryMatch, referenceStatus } = args;
  return {
    id: generateId(),
    sequenceId,
    locationId: location.locationId,
    name: location.name,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    type: location.type ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    timeOfDay: location.timeOfDay ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    description: location.description ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    architecturalStyle: location.architecturalStyle ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    keyFeatures: location.keyFeatures ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    colorPalette: location.colorPalette ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    lightingSetup: location.lightingSetup ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    ambiance: location.ambiance ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    consistencyTag: location.consistencyTag ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionSceneId: location.firstMention?.sceneId ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionText: location.firstMention?.text ?? null,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    firstMentionLine: location.firstMention?.lineNumber ?? null,
    referenceStatus,
    libraryLocationId: libraryMatch?.libraryLocationId ?? null,
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
    characterBible: CharacterBibleEntry[];
    talentMatches: TalentCharacterMatch[];
    locationBible: LocationBibleEntry[];
    locationMatches: LibraryLocationMatch[];
    elementBible: ElementBibleEntry[];
    existingElements: Array<
      Pick<SequenceElementMinimal, 'id' | 'token' | 'imageUrl'>
    >;
  }
): Promise<{ elements: SequenceElementMinimal[] }> {
  const { sequenceId } = args;
  const talentByCharacter = new Map(
    args.talentMatches.map((m) => [m.characterId, m])
  );
  for (const character of args.characterBible) {
    await scopedDb.characters.create(
      buildCharacterInsert({
        sequenceId,
        character,
        talentMatch: talentByCharacter.get(character.characterId),
        sheetStatus: 'pending',
      })
    );
  }

  const libraryByLocation = new Map(
    args.locationMatches.map((m) => [m.locationId, m])
  );
  await scopedDb.sequenceLocations.createBulk(
    args.locationBible.map((location) =>
      buildLocationInsert({
        sequenceId,
        location,
        libraryMatch: libraryByLocation.get(location.locationId),
        referenceStatus: 'pending',
      })
    )
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
    });
  }
  return { elements };
}
