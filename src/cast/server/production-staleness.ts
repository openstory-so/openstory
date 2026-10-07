import { NotFoundError } from '@/platform/errors';
import { characterBibleChanged } from '@/cast/server/db/bible-versions';
import { CHARACTER_LABELS, lookMoved } from '@/shots/server/shot-staleness';
import { wearLook } from '@/cast/character-looks';
import { requireCharacterLook } from '@/cast/server/character-look';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { productionAccess } from '@/sequences/server/production-access';
import { buildCharacterSheetDraft } from './sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from './sheets/location-sheet-trigger';
import type { SheetStaleness } from './sheets/sheet-staleness';
import {
  characterSheetHashMatchesStored,
  finishCharacterSheetPayload,
  locationSheetHashMatchesStored,
} from './workflows/sheet-snapshots';

/**
 * A reference sheet's freshness: the hash a regenerate would stamp now,
 * against the one the live sheet was stamped with. The one verdict behind the
 * detail-page banners and the MCP read. A voice-only character has no sheet
 * to be stale (#1585).
 */
export async function readReferenceStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  kind: 'character' | 'location',
  entityId: string
): Promise<{ status: SheetStaleness; applicable: boolean }> {
  // A character's own sheet is its default look's, whose id is the
  // character's (#2015).
  if (kind === 'character') {
    return readLookSheetStaleness(scopedDb, sequenceId, entityId, entityId);
  }
  const access = productionAccess(scopedDb);
  const context = {
    scopedDb,
    sequence: await access.sequence(sequenceId),
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  };

  const location = await access.location(sequenceId, entityId);
  const stored = location.referenceInputHash;
  if (location.referenceStatus === 'generating')
    return { status: 'generating', applicable: true };
  if (!stored) return { status: 'untracked', applicable: true };
  const payload = await buildRegenerateLocationSheetPayload({
    ...context,
    location,
  });
  if (!payload.snapshotInputHash)
    return { status: 'untracked', applicable: true };
  return {
    status: (await locationSheetHashMatchesStored(stored, payload))
      ? 'fresh'
      : 'stale',
    applicable: true,
  };
}

/**
 * One look's sheet freshness (#2015). An id that is not a look of this
 * character is an error, never the default look's verdict.
 */
/**
 * What moved between the versions a parked sheet was drawn from
 * (`character_sheet_variants.bibleVersionId` / `lookVersionId`, stamped by
 * the land) and the ones this sequence pins now (#1862): the bible fields
 * and look fields, in plain words, for the compare dialog. Empty when the
 * sheet reads the pinned versions; a sheet from before the stamps (an
 * upload, a pre-#1600 row) names nothing.
 */
export async function sheetVersionDiff(
  scopedDb: ScopedDb,
  sequenceId: string,
  variantId: string
): Promise<string[]> {
  const variant = await scopedDb.characterSheetVariants.getById(variantId);
  if (!variant) throw new NotFoundError(`Sheet ${variantId} not found`);
  const owner = await productionAccess(scopedDb).character(
    sequenceId,
    variant.characterId
  );
  const changes: string[] = [];
  if (
    variant.bibleVersionId &&
    variant.bibleVersionId !== owner.selectedBibleVersionId
  ) {
    const then = await scopedDb.characters.getBibleVersion(
      variant.bibleVersionId
    );
    changes.push(
      ...characterBibleChanged(then, owner).map((k) => CHARACTER_LABELS[k])
    );
  }
  const look = owner.looks.find((l) => l.id === (variant.lookId ?? owner.id));
  if (
    look &&
    variant.lookVersionId &&
    variant.lookVersionId !== look.lookVersionId
  ) {
    const then = (await scopedDb.characterLooks.listVersions(look.id)).find(
      (v) => v.id === variant.lookVersionId
    );
    if (then) {
      changes.push(
        ...lookMoved(then, {
          standardClothing: look.clothing,
          styling: look.styling,
        })
      );
    }
  }
  return changes;
}

export async function readLookSheetStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  characterId: string,
  lookId: string
): Promise<{ status: SheetStaleness; applicable: boolean }> {
  const access = productionAccess(scopedDb);
  const context = {
    scopedDb,
    sequence: await access.sequence(sequenceId),
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  };
  const owner = await access.character(sequenceId, characterId);
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
  const { draft, isDefault, liveFace } = await buildCharacterSheetDraft({
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
    status: (await characterSheetHashMatchesStored(stored, payload))
      ? 'fresh'
      : 'stale',
    applicable: true,
  };
}
