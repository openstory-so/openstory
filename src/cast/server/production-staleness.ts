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
  diffManifests,
  manifestOfHash,
  type InputManifest,
} from '@/shots/input-hash';
import {
  describeManifestCauses,
  type ManifestArtifact,
} from '@/shots/staleness-causes';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cast', 'sheet-staleness']);

/** A sheet verdict with what moved (#2344); empty when fresh or stamped before manifests. */
export type SheetVerdict = {
  status: SheetStaleness;
  applicable: boolean;
  causes: string[];
};

/**
 * The stored manifest for `stored` against the one `live` left in memory.
 * No stored manifest is a sheet stamped before #2344: no cause. Matching
 * manifests under a stale verdict is a stamp ≠ verify bug: logged, unnamed.
 */
function sheetCauses(
  manifests: ReadonlyMap<string, InputManifest>,
  artifact: ManifestArtifact,
  stored: string,
  live: string
): string[] {
  const was = manifests.get(stored);
  const now = manifestOfHash(live);
  if (!was || !now) return [];
  const moved = diffManifests(was, now);
  if (moved.length === 0) {
    logger.error(
      `stale ${artifact} with no differing input: stamp and verify disagree`,
      {
        stored,
        live,
      }
    );
    return [];
  }
  return describeManifestCauses(artifact, moved);
}
import {
  characterSheetHashMatchesStored,
  uploadedCharacterSheetHashMatchesStored,
  finishCharacterSheetPayload,
  locationSheetHashMatchesStored,
  uploadedLocationSheetHashMatchesStored,
} from './workflows/sheet-snapshots';

/** What a sheet verdict takes of the sequence; null from the organization pages. */
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
): Promise<SheetVerdict> {
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
  const [rows, styleConfig, manifests] = await Promise.all([
    loadLocationSheetPayloadRows(scopedDb, location),
    sequence === null
      ? null
      : resolveSequenceStyle(scopedDb, sequence).then((s) => s ?? null),
    scopedDb.inputManifests.getByHashes([location.referenceInputHash]),
  ]);
  return locationSheetStaleness({
    scopedDb,
    sequence,
    location,
    styleConfig,
    rows,
    manifests,
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
  /** Stored manifests by hash (`inputManifests.getByHashes`); the plan reads every sheet's in one batch. */
  manifests: ReadonlyMap<string, InputManifest>;
}): Promise<SheetVerdict> {
  const { scopedDb, sequence, location, styleConfig, rows, manifests } = args;
  const stored = location.referenceInputHash;
  if (location.referenceStatus === 'generating')
    return { status: 'generating', applicable: true, causes: [] };
  if (!stored) return { status: 'untracked', applicable: true, causes: [] };
  const payload = await buildRegenerateLocationSheetPayload({
    scopedDb,
    sequence,
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
    location,
    preloaded: rows,
  });
  if (!payload.snapshotInputHash)
    return { status: 'untracked', applicable: true, causes: [] };
  const fresh = await (
    rows.liveVersion?.model === USER_UPLOAD_MODEL
      ? uploadedLocationSheetHashMatchesStored
      : locationSheetHashMatchesStored
  )(stored, payload, {
    // What a digest stamped before #1695 read: the library reference it
    // was drawn from and the sequence's style. None from no sequence, so
    // such a digest reads stale there.
    libraryLocationReferenceHash: location.legacyLibraryReferenceHash,
    styleConfig,
  });
  return {
    status: fresh ? 'fresh' : 'stale',
    applicable: true,
    causes: fresh
      ? []
      : sheetCauses(
          manifests,
          'location-sheet',
          stored,
          payload.snapshotInputHash
        ),
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
): Promise<SheetVerdict> {
  const [sequence, owner] = await Promise.all([
    sequenceId === null
      ? null
      : productionAccess(scopedDb).sequence(sequenceId),
    requireCharacter(scopedDb, sequenceId, characterId),
  ]);
  if (owner.voiceOnly)
    return { status: 'untracked', applicable: false, causes: [] };
  const look = await requireCharacterLook(scopedDb, owner, lookId);
  const [rows, styleConfigHash, manifests] = await Promise.all([
    loadCharacterSheetDraftRows(scopedDb, wearLook(owner, look)),
    sequence === null ? null : sequenceStyleHash(scopedDb, sequence),
    scopedDb.inputManifests.getByHashes([look.sheetInputHash]),
  ]);
  return lookSheetStaleness({
    scopedDb,
    sequence,
    owner,
    lookId,
    styleConfigHash,
    rows,
    manifests,
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
  /** Stored manifests by hash (`inputManifests.getByHashes`); the plan reads every sheet's in one batch. */
  manifests: ReadonlyMap<string, InputManifest>;
}): Promise<SheetVerdict> {
  const {
    scopedDb,
    sequence,
    owner,
    lookId,
    styleConfigHash,
    rows,
    manifests,
  } = args;
  if (owner.voiceOnly)
    return { status: 'untracked', applicable: false, causes: [] };
  const character = wearLook(
    owner,
    await requireCharacterLook(scopedDb, owner, lookId)
  );
  const stored = character.sheetInputHash;
  if (character.sheetStatus === 'generating')
    return { status: 'generating', applicable: true, causes: [] };
  if (!stored) return { status: 'untracked', applicable: true, causes: [] };
  // What a regenerate would stamp now. A look whose default has no sheet
  // yet hashes with no face: it cannot be drawn, and its old sheet was not
  // drawn from one either.
  const { draft, isDefault, liveFace, liveVersionModel } =
    await buildCharacterSheetDraft(
      {
        scopedDb,
        sequence,
        userId: scopedDb.userId,
        organizationId: scopedDb.organizationId,
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
    return { status: 'untracked', applicable: true, causes: [] };
  const fresh = await (
    liveVersionModel === USER_UPLOAD_MODEL
      ? uploadedCharacterSheetHashMatchesStored
      : characterSheetHashMatchesStored
  )(stored, payload, legacyStylingParts(character), styleConfigHash);
  return {
    status: fresh ? 'fresh' : 'stale',
    applicable: true,
    causes: fresh
      ? []
      : sheetCauses(
          manifests,
          'character-sheet',
          stored,
          payload.snapshotInputHash
        ),
  };
}
