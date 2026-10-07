/**
 * Build a CharacterSheetWorkflow payload from the live character row and one
 * of its looks (#2015) — regenerate-from-bible, no talent picker, no shot
 * regen.
 */

import { wearLook } from '@/cast/character-looks';
import { defaultLookFace, lookSheetFaceRefusal } from '@/cast/look-sheet-face';
import { ValidationError } from '@/platform/errors';
import { requireCharacterLook } from '@/cast/server/character-look';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import type { CharacterSheetWorkflowInput } from '@/platform/server/workflow/types';
import { finishCharacterSheetPayload } from '@/cast/server/workflows/sheet-snapshots';
import type {
  CastTalentFields,
  CharacterSheetDraft,
} from '@/cast/server/workflows/sheet-snapshots';

const NOT_CAST: CastTalentFields = {
  referenceImageUrl: undefined,
  talentMetadata: undefined,
  talentSheetInputHash: null,
  castTalentDescription: null,
};

/**
 * Resolve what a cast talent feeds a character sheet: the talent's reference
 * sheet (image, look metadata, `input_hash`) and its own description. One
 * resolver for the regenerate/verify payload and the upload stamp, so they
 * cannot drift. A talent with no reference sheet yet feeds no image (#2018).
 */
export async function resolveCastTalent(
  scopedDb: Pick<ScopedDb, 'talent'>,
  cast: { talentId: string | null; talentVersionId: string | null }
): Promise<CastTalentFields> {
  if (!cast.talentId) return NOT_CAST;
  // The talent AS THE CAST WAS MADE FROM IT (#1862): the version the bible
  // version records, not the live row. A talent edit moves no cast until a
  // person adopts the current version.
  if (!cast.talentVersionId) {
    throw new Error(
      `Cast with talent ${cast.talentId} records no talent version; recast the character`
    );
  }
  const version = await scopedDb.talent.versions.getById(cast.talentVersionId);
  if (!version) return NOT_CAST;
  const sheet = version.sheetId
    ? await scopedDb.talent.sheets.getById(version.sheetId)
    : undefined;
  return {
    referenceImageUrl: sheet?.imageUrl ?? undefined,
    talentMetadata: sheet?.metadata ?? undefined,
    talentSheetInputHash: sheet?.inputHash ?? null,
    castTalentDescription: version.description,
  };
}

type SheetPayloadParams = {
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
  /** The look to draw. The character's default look is `character.lookId`. */
  lookId: string;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
};

/**
 * Everything a sheet payload snapshots from the live rows except the face,
 * plus what the face would be now: the default look's selected sheet, or
 * null when this look is the default or that sheet does not exist yet.
 */
export async function buildCharacterSheetDraft(
  params: SheetPayloadParams
): Promise<{
  draft: CharacterSheetDraft;
  isDefault: boolean;
  liveFace: CharacterSheetWorkflowInput['face'];
  /** Why this look cannot be drawn now; null when it can. */
  refusal: string | null;
}> {
  const { scopedDb, userId, teamId, sequence } = params;
  const look = await requireCharacterLook(
    scopedDb,
    params.character,
    params.lookId
  );
  // Read before dressing: the character wears the default look, and the
  // worn row's sheet fields are the look being drawn.
  const liveFace = look.isDefault
    ? null
    : defaultLookFace(params.character.looks);
  const refusal = lookSheetFaceRefusal(params.character.looks, look.isDefault);
  const character = wearLook(params.character, look);
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

  const cast = await resolveCastTalent(scopedDb, character);

  const liveVersion = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;

  const draft: CharacterSheetDraft = {
    userId,
    teamId,
    sequenceId: sequence.id,
    characterDbId: character.id,
    lookId: look.id,
    lookVersionId: look.lookVersionId,
    lookStyling: look.styling,
    talentId: character.talentId,
    characterName: character.name,
    // Dressed: `standardClothing` is this look's clothing.
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
  return { draft, isDefault: look.isDefault, liveFace, refusal };
}

/**
 * The payload a sheet run takes, drawn now. A look other than the default is
 * drawn from the default look's selected sheet, and is refused while there
 * is none: every caller that starts a run (regenerate, a plan's references)
 * comes through here, so none can draw a look from the talent instead.
 */
export async function buildRegenerateCharacterSheetPayload(
  params: SheetPayloadParams
): Promise<Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>> {
  const { draft, isDefault, liveFace, refusal } =
    await buildCharacterSheetDraft(params);
  if (refusal) throw new ValidationError(refusal);
  return await finishCharacterSheetPayload(draft, isDefault ? null : liveFace);
}
