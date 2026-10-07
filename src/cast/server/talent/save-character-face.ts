/**
 * Save a character's FACE as a new talent (#2018): the name, the physical
 * description and the sheet this sequence selected for it, which lands as the
 * talent's reference sheet through the library sheet run (claimed, copied,
 * cropped for the headshot). Nothing else crosses.
 *
 * The rights gate (#1180, #1581) holds across the copy. The character's sheet
 * is either generated (an AI face: `isHuman` false, no ledger row to carry) or
 * a user upload, whose likeness verdict and sign-off live in the ledger under
 * the ORIGINAL upload URL. For an upload: `requireUploadRights` refuses
 * unless that URL is cleared or signed (no row, or a real person with no
 * sign-off, fails closed); `isHuman` is the ledger's answer; and the row is
 * re-keyed to the URL the run will copy the sheet to, BEFORE the run starts,
 * so the talent's sheet is covered by the same evidence as the upload was.
 */

import { generateId } from '@/platform/id';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
} from '@/platform/server/storage/buckets';
import type { LibraryTalentSheetWorkflowInput } from '@/platform/server/workflow/types';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import {
  carryUploadRights,
  requireUploadRights,
} from '@/cast/server/upload-rights';
import { computeLibraryTalentSheetHashFromDto } from '@/cast/server/workflows/sheet-snapshots';
import type { SheetPayload } from '@/cast/server/workflows/sheet-snapshots';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';
import { enqueueLibraryTalentSheet } from './enqueue-library-talent-sheet';

/** Where the library sheet run stores a talent's sheet (`sheetId` is the claim). */
export function talentSheetStoragePath(
  teamId: string,
  talentId: string,
  sheetId: string
): string {
  return `${teamId}/${talentId}/${sheetId}.png`;
}

export async function saveCharacterFaceAsTalent(
  scopedDb: ScopedDb,
  ctx: { userId: string; teamId: string },
  data: { sequenceId: string; characterId: string }
) {
  // Verify the sequence belongs to this team
  await scopedDb.sequences.getForUser({ sequenceId: data.sequenceId });

  const character = await scopedDb.characters.getById(
    data.sequenceId,
    data.characterId
  );
  if (!character) {
    throw new Error('Character not found');
  }
  const sheet = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;
  if (!sheet?.url || !character.sheetImageUrl) {
    throw new ValidationError(
      `${character.name} has no sheet yet. Generate one first.`
    );
  }

  // An upload keeps its rights; a generated sheet is an AI face.
  const uploaded = sheet.model === USER_UPLOAD_MODEL;
  const isHuman = uploaded
    ? (await requireUploadRights(scopedDb, [sheet.url])).get(sheet.url)
        ?.depictsRealPerson === true
    : false;

  const newTalent = await scopedDb.talent.create({
    name: character.name,
    description: character.physicalDescription ?? undefined,
    isFavorite: false,
    isHuman,
    isInTeamLibrary: true,
  });

  const sheetId = generateId();
  if (uploaded) {
    await carryUploadRights(
      scopedDb,
      sheet.url,
      getPublicUrl(
        STORAGE_BUCKETS.TALENT,
        talentSheetStoragePath(ctx.teamId, newTalent.id, sheetId)
      )
    );
  }

  const workflowInputFields: SheetPayload<LibraryTalentSheetWorkflowInput> = {
    userId: ctx.userId,
    teamId: ctx.teamId,
    talentId: newTalent.id,
    talentName: newTalent.name,
    talentDescription: newTalent.description ?? undefined,
    referenceImageUrls: [],
    uploadedSheetUrl: sheet.url,
    uploadedSheetMetadata: characterToBible(character),
  };
  const workflowInput = {
    ...workflowInputFields,
    snapshotInputHash:
      await computeLibraryTalentSheetHashFromDto(workflowInputFields),
  };
  const runId = await enqueueLibraryTalentSheet(scopedDb, {
    talentId: newTalent.id,
    workflowInput,
    activity: 'portrait',
    sheetId,
  });
  return { talent: newTalent, runId };
}
