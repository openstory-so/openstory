/**
 * Build a CharacterSheetWorkflow payload from the live character row and one
 * of its looks (#2015) — regenerate-from-bible, no talent picker, no shot
 * regen.
 */

import { wearLook } from '@/cast/character-looks';
import { defaultLookFace, lookSheetFaceRefusal } from '@/cast/look-sheet-face';
import { ValidationError } from '@/platform/errors';
import { requireCharacterLook } from '@/cast/server/character-look';
import type {
  CharacterSheetVariant,
  CharacterWithSheet,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import type { CharacterSheetWorkflowInput } from '@/platform/server/workflow/types';
import { finishCharacterSheetPayload } from '@/cast/server/workflows/sheet-snapshots';
import type { CharacterSheetDraft } from '@/cast/server/workflows/sheet-snapshots';

type SheetPayloadParams = {
  scopedDb: ScopedDb;
  userId: string;
  teamId: string;
  /**
   * The sequence the sheet is drawn from, for its image model and the run's
   * channel; null from the Characters page (#2017), where the model is the
   * live version's or the default.
   */
  sequence: { id: string; imageModel: string | null } | null;
  character: CharacterWithSheet;
  /** The look to draw. The character's default look is `character.lookId`. */
  lookId: string;
  /** Generate-time pick; omit to reuse the live version's model or the sequence default. */
  imageModel?: string | null;
};

/**
 * The live sheet version a draft reads besides the character. Read once per
 * sheet by `loadCharacterSheetDraftRows`, or once per sequence by the
 * generation plan (#2082).
 */
export type CharacterSheetDraftRows = {
  liveVersion: Pick<CharacterSheetVariant, 'model'> | null;
};

export async function loadCharacterSheetDraftRows(
  scopedDb: Pick<ScopedDb, 'characterSheetVariants'>,
  character: Pick<CharacterWithSheet, 'selectedSheetVersionId'>
): Promise<CharacterSheetDraftRows> {
  const liveVersion = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;
  return { liveVersion: liveVersion ?? null };
}

/**
 * Everything a sheet payload snapshots from the live rows except the face,
 * plus what the face would be now: the default look's selected sheet, or
 * null when this look is the default or that sheet does not exist yet.
 */
export async function buildCharacterSheetDraft(
  params: SheetPayloadParams,
  /** Already read for this worn look; omitted, they are read here. */
  preloaded?: CharacterSheetDraftRows
): Promise<{
  draft: CharacterSheetDraft;
  isDefault: boolean;
  liveFace: CharacterSheetWorkflowInput['face'];
  /** Why this look cannot be drawn now; null when it can. */
  refusal: string | null;
  /** The selected sheet version's `model`; null when there is no sheet. */
  liveVersionModel: string | null;
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
  const { liveVersion } =
    preloaded ?? (await loadCharacterSheetDraftRows(scopedDb, character));

  const draft: CharacterSheetDraft = {
    userId,
    teamId,
    sequenceId: sequence?.id ?? null,
    characterDbId: character.id,
    lookId: look.id,
    lookVersionId: look.lookVersionId,
    lookStyling: look.styling,
    characterName: character.name,
    // Dressed: `standardClothing` is this look's clothing.
    characterMetadata: characterToBible(character),
    bibleVersionId: character.selectedBibleVersionId,
    imageModel: resolveSheetImageModel({
      explicit: params.imageModel,
      liveVersionModel: liveVersion?.model,
      sequenceImageModel: sequence?.imageModel ?? null,
    }),
  };
  return {
    draft,
    isDefault: look.isDefault,
    liveFace,
    refusal,
    liveVersionModel: liveVersion?.model ?? null,
  };
}

/**
 * The payload a sheet run takes, drawn now. A look other than the default is
 * drawn from the default look's selected sheet, and is refused while there
 * is none: every caller that starts a run (regenerate, a plan's references)
 * comes through here.
 */
export async function buildRegenerateCharacterSheetPayload(
  params: SheetPayloadParams
): Promise<Omit<CharacterSheetWorkflowInput, 'sheetVersionId'>> {
  const { draft, isDefault, liveFace, refusal } =
    await buildCharacterSheetDraft(params);
  if (refusal) throw new ValidationError(refusal);
  return await finishCharacterSheetPayload(draft, isDefault ? null : liveFace);
}
