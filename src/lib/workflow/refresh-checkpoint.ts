/**
 * Re-snapshot the bibles in a generation checkpoint from the cast rows the
 * Script stage created.
 *
 * A run stopped at Script exists so the user can review — and edit, recast,
 * delete — the cast before any sheet is billed. The References stage
 * re-upserts those rows from the checkpoint bible, so if the bible still
 * carried the LLM's original values a continue would silently revert every
 * edit. Runs at the trigger (a snapshot, per the no-mid-run-reads rule), only
 * where rows exist: a checkpoint whose casting never landed keeps its bible.
 *
 * The same goes one stage later: a References stop exists to review the
 * sheets, so the sheet snapshots shot-images renders against (URL, selected
 * version, input hash) are re-read too — otherwise a regenerated sheet is
 * ignored and the still's manifest hashes against a retired version.
 */

import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { CharacterMinimal } from '@/lib/db/schema/characters';
import type { SequenceLocationMinimal } from '@/lib/db/schema/sequence-locations';
import type { GenerationCheckpoint } from '@/shared/generation/pipeline';
import type {
  LibraryLocationMatch,
  TalentCharacterMatch,
} from '@/lib/workflow/types';
import { toCharacterMetadata } from '@/lib/sheets/character-sheet-trigger';
import { toLocationMetadata } from '@/lib/sheets/location-sheet-trigger';

export async function refreshCheckpointFromCast(
  scopedDb: ScopedDb,
  sequenceId: string,
  checkpoint: GenerationCheckpoint
): Promise<GenerationCheckpoint> {
  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.list(sequenceId),
    scopedDb.sequenceLocations.list(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
  ]);
  const next: GenerationCheckpoint = { ...checkpoint };

  if (characters.length > 0) {
    next.characterBible = characters.map(toCharacterMetadata);
    const talentMatches: TalentCharacterMatch[] = [];
    for (const character of characters) {
      if (!character.talentId) continue;
      const talent = await scopedDb.talent.getWithRelations(character.talentId);
      const convergent = talent?.sheets.filter((s) => !s.divergedAt) ?? [];
      const sheet = convergent.find((s) => s.isDefault) ?? convergent[0];
      if (!talent || !sheet?.imageUrl) continue;
      talentMatches.push({
        characterId: character.characterId,
        talentId: talent.id,
        talentName: talent.name,
        sheetImageUrl: sheet.imageUrl,
        sheetMetadata: sheet.metadata ?? undefined,
        talentDescription: talent.description ?? undefined,
      });
    }
    next.talentMatches = talentMatches;
  }

  if (locations.length > 0) {
    next.locationBible = locations.map(toLocationMetadata);
    const locationMatches: LibraryLocationMatch[] = [];
    for (const location of locations) {
      if (!location.libraryLocationId) continue;
      const library = await scopedDb.locations.getById(
        location.libraryLocationId
      );
      if (!library?.referenceImageUrl) continue;
      locationMatches.push({
        locationId: location.locationId,
        libraryLocationId: library.id,
        libraryLocationName: library.name,
        referenceImageUrl: library.referenceImageUrl,
        description: library.description ?? undefined,
      });
    }
    next.locationMatches = locationMatches;
  }

  if (elements.length > 0) {
    next.elementBible = elements.map((el): ElementBibleEntry => ({
      token: el.token,
      description: el.description ?? '',
      consistencyTag: el.consistencyTag ?? '',
      firstMention: {
        sceneId: el.firstMentionSceneId ?? '',
        text: el.firstMentionText ?? '',
        lineNumber: el.firstMentionLine ?? 0,
      },
    }));
  }

  // Sheet snapshots exist only past References; a Script checkpoint has none
  // and must not gain any, or the workflow would think References ran.
  if (next.charactersWithSheets) {
    next.charactersWithSheets = characters.map((c): CharacterMinimal => ({
      id: c.id,
      characterId: c.characterId,
      name: c.name,
      sheetImageUrl: c.sheetImageUrl,
      sheetStatus: c.sheetStatus,
      sheetInputHash: c.sheetInputHash,
      selectedSheetVersionId: c.selectedSheetVersionId,
      physicalDescription: c.physicalDescription,
      consistencyTag: c.consistencyTag,
    }));
  }
  if (next.locationsWithSheets) {
    next.locationsWithSheets = locations.map((l): SequenceLocationMinimal => ({
      id: l.id,
      locationId: l.locationId,
      name: l.name,
      referenceImageUrl: l.referenceImageUrl,
      referenceStatus: l.referenceStatus,
      referenceInputHash: l.referenceInputHash,
      selectedReferenceVersionId: l.selectedReferenceVersionId,
      description: l.description,
      consistencyTag: l.consistencyTag,
    }));
  }
  if (next.allElements) {
    next.allElements = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
    }));
  }

  return next;
}
