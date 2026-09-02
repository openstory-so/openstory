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
 */

import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { GenerationCheckpoint } from '@/lib/generation/pipeline';
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
    const talentMatches: NonNullable<GenerationCheckpoint['talentMatches']> =
      [];
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
    const locationMatches: NonNullable<
      GenerationCheckpoint['locationMatches']
    > = [];
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

  return next;
}
