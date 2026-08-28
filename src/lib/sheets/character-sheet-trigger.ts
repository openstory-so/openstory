/**
 * Build a CharacterSheetWorkflow payload from the live character row —
 * regenerate-from-bible, no talent picker, no shot regen.
 */

import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { Character } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { resolveSheetImageModel } from '@/lib/sheets/sheet-image-model';
import { resolveSequenceStyleConfig } from '@/lib/style/style-config';
import type { CharacterSheetWorkflowInput } from '@/lib/workflow/types';
import { computeCharacterSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';

function toCharacterMetadata(character: Character): CharacterBibleEntry {
  return {
    characterId: character.characterId,
    name: character.name,
    age: character.age ?? '',
    gender: character.gender ?? '',
    ethnicity: character.ethnicity ?? '',
    physicalDescription: character.physicalDescription ?? '',
    standardClothing: character.standardClothing ?? '',
    distinguishingFeatures: character.distinguishingFeatures ?? '',
    consistencyTag: character.consistencyTag ?? '',
  };
}

export async function buildRegenerateCharacterSheetPayload(params: {
  scopedDb: ScopedDb;
  userId: string;
  teamId: string;
  sequence: {
    id: string;
    styleId: string | null;
    styleConfig: Parameters<typeof resolveSequenceStyleConfig>[0]['snapshot'];
    imageModel: string | null;
  };
  character: Character;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
}): Promise<CharacterSheetWorkflowInput> {
  const { scopedDb, userId, teamId, sequence, character } = params;
  const style =
    sequence.styleConfig == null && sequence.styleId
      ? await scopedDb.styles.getById(sequence.styleId)
      : null;
  const styleConfig =
    sequence.styleConfig != null || style
      ? resolveSequenceStyleConfig({
          snapshot: sequence.styleConfig,
          live: style?.config,
        })
      : undefined;

  let referenceImageUrl: string | undefined;
  let talentMetadata: CharacterBibleEntry | undefined;
  let talentDescription: string | undefined;
  let talentSheetInputHash: string | null = null;

  if (character.talentId) {
    const talent = await scopedDb.talent.getWithRelations(character.talentId);
    const convergent = talent?.sheets.filter((s) => !s.divergedAt) ?? [];
    const defaultSheet = convergent.find((s) => s.isDefault) ?? convergent[0];
    referenceImageUrl = defaultSheet?.imageUrl ?? undefined;
    talentMetadata = defaultSheet?.metadata ?? undefined;
    talentDescription = talent?.description ?? undefined;
    talentSheetInputHash = defaultSheet?.inputHash ?? null;
  }

  const liveVersion = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;

  const partial: CharacterSheetWorkflowInput = {
    userId,
    teamId,
    sequenceId: sequence.id,
    characterDbId: character.id,
    characterName: character.name,
    characterMetadata: toCharacterMetadata(character),
    imageModel: resolveSheetImageModel({
      explicit: params.imageModel,
      liveVersionModel: liveVersion?.model,
      sequenceImageModel: sequence.imageModel,
    }),
    referenceImageUrl,
    talentMetadata,
    talentDescription,
    // Always generate: reuse would skip the bible edit the user just saved.
    reuseTalentSheet: false,
    styleConfig,
    talentSheetInputHash,
  };
  partial.snapshotInputHash = await computeCharacterSheetHashFromDto(partial);
  return partial;
}
