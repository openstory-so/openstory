import { computeStyleConfigHash } from '@/cast/server/workflows/sheet-snapshots';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';
import { wearLook } from '@/cast/character-looks';
import { resolveSequenceStyle } from '@/cast/server/sheets/sequence-style';
import { legacyStylingParts } from '@/cast/server/bibles-from-scoped';
import { requireCharacterLook } from '@/cast/server/character-look';
import { requireCharacter, requireLocation } from '@/cast/server/cast-edit';
import type {
  CharacterWithSheet,
  LocationWithReference,
  Sequence,
  SequenceLocationWithReference,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { StyleConfig } from '@/look/style-config';
import { productionAccess } from '@/sequences/server/production-access';
import {
  buildCharacterSheetDraft,
  loadCharacterSheetDraftRows,
  type CharacterSheetDraftRows,
} from './sheets/character-sheet-trigger';
import {
  buildRegenerateLocationSheetPayload,
  loadLocationSheetPayloadRows,
  type LocationSheetPayloadRows,
} from './sheets/location-sheet-trigger';
import type { SheetStaleness } from './sheets/sheet-staleness';
import {
  characterSheetHashMatchesStored,
  uploadedCharacterSheetHashMatchesStored,
  finishCharacterSheetPayload,
  locationSheetHashMatchesStored,
  uploadedLocationSheetHashMatchesStored,
} from './workflows/sheet-snapshots';

/** What a sheet verdict takes of the sequence; null from the team pages. */
type SheetSequence = Pick<
  Sequence,
  'id' | 'imageModel' | 'styleId' | 'styleConfig'
>;

/**
 * A reference sheet's freshness: the hash a regenerate would stamp now,
 * against the one the live sheet was stamped with. The one verdict behind the
 * detail-page banners and the MCP read. A voice-only character has no sheet
 * to be stale (#1585).
 *
 * Reads the rows by id, then compares in `lookSheetStaleness` /
 * `locationSheetStaleness`. The generation plan reads every sheet's rows in
 * one batch and calls the compares directly (#2082).
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
  const [rows, styleConfig] = await Promise.all([
    loadLocationSheetPayloadRows(scopedDb, location),
    sequence === null
      ? null
      : resolveSequenceStyle(scopedDb, sequence).then((s) => s ?? null),
  ]);
  return locationSheetStaleness({
    scopedDb,
    sequence,
    location,
    styleConfig,
    rows,
  });
}

/** A location sheet's verdict from rows already read. */
export async function locationSheetStaleness(args: {
  scopedDb: ScopedDb;
  sequence: SheetSequence | null;
  location: LocationWithReference | SequenceLocationWithReference;
  /** The sequence's style, for a digest stamped before #1695; null from no sequence. */
  styleConfig: StyleConfig | null;
  rows: LocationSheetPayloadRows;
}): Promise<{ status: SheetStaleness; applicable: boolean }> {
  const { scopedDb, sequence, location, styleConfig, rows } = args;
  const stored = location.referenceInputHash;
  if (location.referenceStatus === 'generating')
    return { status: 'generating', applicable: true };
  if (!stored) return { status: 'untracked', applicable: true };
  const payload = await buildRegenerateLocationSheetPayload({
    scopedDb,
    sequence,
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
    location,
    preloaded: rows,
  });
  if (!payload.snapshotInputHash)
    return { status: 'untracked', applicable: true };
  return {
    status: (await (
      rows.liveVersion?.model === USER_UPLOAD_MODEL
        ? uploadedLocationSheetHashMatchesStored
        : locationSheetHashMatchesStored
    )(stored, payload, {
      // What a digest stamped before #1695 read: the library reference it
      // was drawn from and the sequence's style. None from no sequence, so
      // such a digest reads stale there.
      libraryLocationReferenceHash: location.legacyLibraryReferenceHash,
      styleConfig,
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
  const [sequence, owner] = await Promise.all([
    sequenceId === null
      ? null
      : productionAccess(scopedDb).sequence(sequenceId),
    requireCharacter(scopedDb, sequenceId, characterId),
  ]);
  if (owner.voiceOnly) return { status: 'untracked', applicable: false };
  const look = await requireCharacterLook(scopedDb, owner, lookId);
  const [rows, styleConfigHash] = await Promise.all([
    loadCharacterSheetDraftRows(scopedDb, wearLook(owner, look)),
    sequence === null ? null : sequenceStyleHash(scopedDb, sequence),
  ]);
  return lookSheetStaleness({
    scopedDb,
    sequence,
    owner,
    lookId,
    styleConfigHash,
    rows,
  });
}

/** The style hash a digest stamped before `rendering` (#2017) carried. */
async function sequenceStyleHash(
  scopedDb: Pick<ScopedDb, 'styles'>,
  sequence: Pick<Sequence, 'styleId' | 'styleConfig'>
): Promise<string> {
  return computeStyleConfigHash(await resolveSequenceStyle(scopedDb, sequence));
}

/** A look's sheet verdict from rows already read. */
export async function lookSheetStaleness(args: {
  scopedDb: ScopedDb;
  sequence: SheetSequence | null;
  owner: CharacterWithSheet;
  /** A look of `owner`; the default look's id is the character's. */
  lookId: string;
  /** `sequenceStyleHash`; null from no sequence, so a pre-#2017 digest reads stale there. */
  styleConfigHash: string | null;
  /** The worn look's live sheet version. */
  rows: CharacterSheetDraftRows;
}): Promise<{ status: SheetStaleness; applicable: boolean }> {
  const { scopedDb, sequence, owner, lookId, styleConfigHash, rows } = args;
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
    await buildCharacterSheetDraft(
      {
        scopedDb,
        sequence,
        userId: scopedDb.userId,
        teamId: scopedDb.teamId,
        character: owner,
        lookId: character.lookId,
      },
      rows
    );
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
    )(stored, payload, legacyStylingParts(character), styleConfigHash))
      ? 'fresh'
      : 'stale',
    applicable: true,
  };
}
