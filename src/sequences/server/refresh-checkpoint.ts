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

import type { ElementBibleEntry } from '@/shots/scene-analysis.schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { CharacterMinimal } from '@/platform/server/db/schema/characters';
import type { SequenceLocationMinimal } from '@/platform/server/db/schema/sequence-locations';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import type {
  LibraryLocationMatch,
  TalentCharacterMatch,
} from '@/platform/server/workflow/types';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { toLocationMetadata } from '@/cast/server/sheets/location-sheet-trigger';
import { loadShotDialogueResolver } from '@/shots/server/shot-dialogue';

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
    next.characterBible = characters.map(characterToBible);
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
        sheetInputHash: sheet.inputHash,
        talentDescription: talent.description ?? undefined,
        personality: talent.personality ?? '',
        movement: talent.movement ?? '',
        voiceId: talent.voiceId,
        voiceDescription: talent.voiceDescription,
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
        referenceInputHash: library.referenceInputHash,
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
      voiceOnly: c.voiceOnly,
      isPerson: c.isPerson,
      consistencyTag: c.consistencyTag,
      voiceId: c.voiceId,
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
  // Dialogue: the clips on the shots, and the authored lines behind them.
  // Both are live by the time a stopped run continues — a user reviewing a
  // References stop can edit a line, and the recording has to say what the
  // shot now says. Keyed by shot id, which the checkpoint's shot mapping
  // already speaks.
  const [shotRows, dialogueVersions] = await Promise.all([
    scopedDb.shots.listBySequence(sequenceId),
    scopedDb.shotDialogue.getSelectedBySequence(sequenceId),
  ]);
  if (next.dialogueClipsByShotId) {
    next.dialogueClipsByShotId = Object.fromEntries(
      shotRows
        .filter((shot) => shot.audioClips && shot.audioClips.length > 0)
        .map((shot) => [shot.id, shot.audioClips ?? []])
    );
  }
  // EVERY live shot, resolved (`shotDialogueResolver`) — not just the shots
  // with a version row. The run cannot read the node, and a shot from before
  // #1657 keeps its lines on its motion prompt row; snapshotting the resolved
  // answer is what lets the run's ladder stop at "the payload said so".
  const selectedMotionByShot =
    await scopedDb.shotPromptVersions.getSelectedMotionByShots(
      shotRows.map((shot) => shot.id)
    );
  const dialogueOf = await loadShotDialogueResolver(
    scopedDb,
    sequenceId,
    shotRows,
    (shotId) => selectedMotionByShot.get(shotId)?.dialogue
  );
  next.dialogueLinesByShotId = Object.fromEntries(
    shotRows
      .filter((shot) => !shot.deletedAt)
      .map((shot) => [shot.id, dialogueOf(shot).lines])
  );
  next.dialogueVersionIdByShotId = Object.fromEntries(
    dialogueVersions.map((version) => [version.shotId, version.id])
  );

  if (next.allElements) {
    next.allElements = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
      kind: el.kind,
      durationSeconds: el.durationSeconds,
    }));
  }

  return next;
}
