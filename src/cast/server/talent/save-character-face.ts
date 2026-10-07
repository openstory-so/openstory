/**
 * Save a character's FACE as a new talent (#2018): the name, the physical
 * description and the sheet this sequence selected for it, which lands as the
 * talent's reference sheet through the library sheet run (claimed, copied,
 * cropped for the headshot). Nothing else crosses.
 *
 * The rights gate (#1180, #1581) holds across the copy, and it FAILS CLOSED:
 * a sheet is treated as a real person's unless it is shown to be generated
 * from no human source, or the likeness ledger has cleared or signed it.
 * See {@link decideFace} for every branch. The portrait statement covers
 * using the likeness to generate images and video, with no per-use scope,
 * so a signed upload may become a library face. For a ledger-backed sheet
 * the row is copied to the URL the run will store the sheet at, BEFORE the
 * run starts, with the original signer kept (`carryUploadRights`).
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
import { enqueueLibraryTalentSheet } from './enqueue-library-talent-sheet';

/** Where the library sheet run stores a talent's sheet (`sheetId` is the claim). */
export function talentSheetStoragePath(
  teamId: string,
  talentId: string,
  sheetId: string
): string {
  return `${teamId}/${talentId}/${sheetId}.png`;
}

/** What the face of a character's selected sheet is, by provenance. */
export type FaceDecision =
  /** A run of ours drew it from a bible with no talent: an AI face. */
  | { kind: 'generated'; url: string }
  /** The ledger must say: cleared (not a person) or signed (a real person). */
  | { kind: 'ledger'; url: string }
  /** Refused, with the reason the user sees. */
  | { kind: 'refused'; reason: string };

/**
 * The branch table. The default is to refuse; only two branches proceed.
 *
 * | the sheet                                             | branch            |
 * | ----------------------------------------------------- | ----------------- |
 * | character cast with a talent (reused or drawn from it)| refused           |
 * | no selected sheet, or no image                        | refused           |
 * | landed by a run of ours (`workflowRunId`), bible      | generated         |
 * |   version it was drawn from has no talent             |                   |
 * | landed by a run, bible version names a talent         | refused           |
 * | landed by a run, bible version unknown                | refused           |
 * | everything else: upload (UI or MCP set-from-upload),  | ledger            |
 * |   backfilled, copied, pre-#1419, unknown provenance   |  (no row → refuse)|
 *
 * `model` is never consulted: a model string is not provenance. Only
 * `landSheetVersion` writes `workflowRunId`.
 */
export async function decideFace(
  scopedDb: Pick<ScopedDb, 'characterSheetVariants' | 'characters'>,
  character: {
    name: string;
    talentId: string | null;
    selectedSheetVersionId: string | null;
    sheetImageUrl: string | null;
  }
): Promise<FaceDecision> {
  if (character.talentId) {
    return {
      kind: 'refused',
      reason: `${character.name}'s face is already a library talent. Cast it from the library instead.`,
    };
  }
  const sheet = character.selectedSheetVersionId
    ? await scopedDb.characterSheetVariants.getById(
        character.selectedSheetVersionId
      )
    : null;
  if (!sheet?.url || !character.sheetImageUrl) {
    return {
      kind: 'refused',
      reason: `${character.name} has no sheet yet. Generate one first.`,
    };
  }
  if (sheet.workflowRunId === null) {
    return { kind: 'ledger', url: sheet.url };
  }
  if (!sheet.bibleVersionId) {
    return {
      kind: 'refused',
      reason: `${character.name}'s sheet does not say which version it was drawn from. Generate a new sheet first.`,
    };
  }
  const version = await scopedDb.characters.getBibleVersion(
    sheet.bibleVersionId
  );
  if (version.talentId) {
    return {
      kind: 'refused',
      reason: `${character.name}'s sheet was drawn from a talent. Cast that talent from the library instead.`,
    };
  }
  return { kind: 'generated', url: sheet.url };
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
  if (!character.sheetImageUrl) {
    throw new ValidationError(
      `${character.name} has no sheet yet. Generate one first.`
    );
  }

  const face = await decideFace(scopedDb, character);
  if (face.kind === 'refused') throw new ValidationError(face.reason);
  // The ledger refuses an unchecked URL and an unsigned real person.
  const isHuman =
    face.kind === 'ledger'
      ? (await requireUploadRights(scopedDb, [face.url])).get(face.url)
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
  if (face.kind === 'ledger') {
    await carryUploadRights(
      scopedDb,
      face.url,
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
    // The same row and string the gate checked and the carry covers: never
    // the character's mirrored `sheetImageUrl`.
    uploadedSheetUrl: face.url,
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
