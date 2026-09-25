/**
 * Build a CharacterSheetWorkflow payload from the live character row —
 * regenerate-from-bible, no talent picker, no shot regen.
 */

import type { CharacterWithSheet } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import type { CharacterSheetWorkflowInput } from '@/platform/server/workflow/types';
import { computeCharacterSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import type {
  CastTalentFields,
  SheetPayload,
} from '@/cast/server/workflows/sheet-snapshots';

const NOT_CAST: CastTalentFields = {
  referenceImageUrl: undefined,
  talentMetadata: undefined,
  talentSheetInputHash: null,
  castTalentDescription: null,
};

/**
 * Resolve what a cast talent feeds a character sheet: the default convergent
 * talent sheet (image, look metadata, `input_hash`) and the talent's own
 * description. One resolver for the regenerate/verify payload and the upload
 * stamp, so they cannot drift.
 */
export async function resolveCastTalent(
  scopedDb: Pick<ScopedDb, 'talent'>,
  talentId: string | null
): Promise<CastTalentFields> {
  if (!talentId) return NOT_CAST;
  const talent = await scopedDb.talent.getWithRelations(talentId);
  if (!talent) return NOT_CAST;
  // Exclude divergent sheets from the fallback identity. A divergent row's
  // `inputHash` represents the parked workflow's snapshot, not the talent's
  // current upstream identity — binding a downstream character sheet to it
  // would fork off a stale lineage from first-time generation onward.
  const convergentSheets = talent.sheets.filter((s) => !s.divergedAt);
  const defaultSheet =
    convergentSheets.find((s) => s.isDefault) ?? convergentSheets[0];
  return {
    referenceImageUrl: defaultSheet?.imageUrl ?? undefined,
    talentMetadata: defaultSheet?.metadata ?? undefined,
    talentSheetInputHash: defaultSheet?.inputHash ?? null,
    castTalentDescription: talent.description,
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
  character: CharacterWithSheet;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
}): Promise<SheetPayload<CharacterSheetWorkflowInput>> {
  const { scopedDb, userId, teamId, sequence, character } = params;
  // The UI hides the button; this is the guard for every other caller.
  if (character.voiceOnly) {
    throw new Error(
      `${character.name} is voice-only (#1585): heard, never seen, no sheet to generate`
    );
  }
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

  const cast = await resolveCastTalent(scopedDb, character.talentId);

  const liveVersion = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;

  const partial: SheetPayload<CharacterSheetWorkflowInput> = {
    userId,
    teamId,
    sequenceId: sequence.id,
    characterDbId: character.id,
    characterName: character.name,
    characterMetadata: characterToBible(character),
    bibleVersionId: character.selectedBibleVersionId,
    imageModel: resolveSheetImageModel({
      explicit: params.imageModel,
      liveVersionModel: liveVersion?.model,
      sequenceImageModel: sequence.imageModel,
    }),
    ...cast,
    talentDescription: cast.castTalentDescription ?? undefined,
    // Always generate: reuse would skip the bible edit the user just saved.
    reuseTalentSheet: false,
    styleConfig,
  };
  partial.snapshotInputHash = await computeCharacterSheetHashFromDto(partial);
  return partial;
}
