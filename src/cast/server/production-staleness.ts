import { computeStyleConfigHash } from '@/cast/server/workflows/sheet-snapshots';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';
import { wearLook } from '@/cast/character-looks';
import { resolveSequenceStyle } from '@/cast/server/sheets/sequence-style';
import { legacyStylingParts } from '@/cast/server/bibles-from-scoped';
import { requireCharacterLook } from '@/cast/server/character-look';
import { requireCharacter, requireLocation } from '@/cast/server/cast-edit';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { productionAccess } from '@/sequences/server/production-access';
import { buildCharacterSheetDraft } from './sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from './sheets/location-sheet-trigger';
import type { SheetStaleness } from './sheets/sheet-staleness';
import {
  characterSheetHashMatchesStored,
  uploadedCharacterSheetHashMatchesStored,
  finishCharacterSheetPayload,
  locationSheetHashMatchesStored,
  uploadedLocationSheetHashMatchesStored,
} from './workflows/sheet-snapshots';

/**
 * A reference sheet's freshness: the hash a regenerate would stamp now,
 * against the one the live sheet was stamped with. The one verdict behind the
 * detail-page banners and the MCP read. A voice-only character has no sheet
 * to be stale (#1585).
 */
export async function readReferenceStaleness(
  scopedDb: ScopedDb,
  /** Null from the Characters or Locations page: no sequence model or style. */
  sequenceId: string | null,
  kind: 'character' | 'location',
  entityId: string
): Promise<{ status: SheetStaleness; applicable: boolean }> {
  // A character's own sheet is its default look's, whose id is the
  // character's (#2015).
  if (kind === 'character') {
    return readLookSheetStaleness(scopedDb, sequenceId, entityId, entityId);
  }
  const sequence =
    sequenceId === null
      ? null
      : await productionAccess(scopedDb).sequence(sequenceId);
  const location = await requireLocation(scopedDb, sequenceId, entityId);
  const stored = location.referenceInputHash;
  if (location.referenceStatus === 'generating')
    return { status: 'generating', applicable: true };
  if (!stored) return { status: 'untracked', applicable: true };
  const [payload, liveVersion] = await Promise.all([
    buildRegenerateLocationSheetPayload({
      scopedDb,
      sequence,
      userId: scopedDb.userId,
      teamId: scopedDb.teamId,
      location,
    }),
    location.selectedReferenceVersionId
      ? scopedDb.locationSheetVariants.getById(
          location.selectedReferenceVersionId
        )
      : null,
  ]);
  if (!payload.snapshotInputHash)
    return { status: 'untracked', applicable: true };
  return {
    status: (await (
      liveVersion?.model === USER_UPLOAD_MODEL
        ? uploadedLocationSheetHashMatchesStored
        : locationSheetHashMatchesStored
    )(stored, payload, {
      // What a digest stamped before #1695 read: the library reference it
      // was drawn from and the sequence's style. None from no sequence, so
      // such a digest reads stale there.
      libraryLocationReferenceHash: location.legacyLibraryReferenceHash,
      styleConfig:
        sequence === null
          ? null
          : ((await resolveSequenceStyle(scopedDb, sequence)) ?? null),
    }))
      ? 'fresh'
      : 'stale',
    applicable: true,
  };
}

/**
 * One look's sheet freshness (#2015). An id that is not a look of this
 * character is an error, never the default look's verdict.
 */
export async function readLookSheetStaleness(
  scopedDb: ScopedDb,
  /** Null from the Characters page (#2017): no sequence model or style. */
  sequenceId: string | null,
  characterId: string,
  lookId: string
): Promise<{ status: SheetStaleness; applicable: boolean }> {
  const access = productionAccess(scopedDb);
  const context = {
    scopedDb,
    sequence: sequenceId === null ? null : await access.sequence(sequenceId),
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  };
  const owner = await requireCharacter(scopedDb, sequenceId, characterId);
  if (owner.voiceOnly) return { status: 'untracked', applicable: false };
  const character = wearLook(
    owner,
    await requireCharacterLook(scopedDb, owner, lookId)
  );
  const stored = character.sheetInputHash;
  if (character.sheetStatus === 'generating')
    return { status: 'generating', applicable: true };
  if (!stored) return { status: 'untracked', applicable: true };
  // What a regenerate would stamp now. A look whose default has no sheet
  // yet hashes with no face: it cannot be drawn, and its old sheet was not
  // drawn from one either.
  const { draft, isDefault, liveFace, liveVersionModel } =
    await buildCharacterSheetDraft({
      ...context,
      character: owner,
      lookId: character.lookId,
    });
  const payload = await finishCharacterSheetPayload(
    draft,
    isDefault ? null : liveFace
  );
  if (!payload.snapshotInputHash)
    return { status: 'untracked', applicable: true };
  return {
    status: (await (
      liveVersionModel === USER_UPLOAD_MODEL
        ? uploadedCharacterSheetHashMatchesStored
        : characterSheetHashMatchesStored
    )(
      stored,
      payload,
      legacyStylingParts(character),
      // The style, for a digest stamped before `rendering` (#2017); none
      // from no sequence, so such a digest reads stale there.
      context.sequence === null
        ? null
        : await computeStyleConfigHash(
            await resolveSequenceStyle(scopedDb, context.sequence)
          )
    ))
      ? 'fresh'
      : 'stale',
    applicable: true,
  };
}
