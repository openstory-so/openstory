import type { ScopedDb } from '@/platform/server/db/scoped';
import { productionAccess } from '@/sequences/server/production-access';
import { buildRegenerateCharacterSheetPayload } from './sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from './sheets/location-sheet-trigger';
import type { SheetStaleness } from './sheets/sheet-staleness';
import {
  characterSheetHashMatchesStored,
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
  const access = productionAccess(scopedDb);
  const context = {
    scopedDb,
    sequence: await access.sequence(sequenceId),
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  };

  if (kind === 'character') {
    const character = await access.character(sequenceId, entityId);
    if (character.voiceOnly) return { status: 'untracked', applicable: false };
    const stored = character.sheetInputHash;
    if (character.sheetStatus === 'generating')
      return { status: 'generating', applicable: true };
    if (!stored) return { status: 'untracked', applicable: true };
    const payload = await buildRegenerateCharacterSheetPayload({
      ...context,
      character,
    });
    if (!payload.snapshotInputHash)
      return { status: 'untracked', applicable: true };
    return {
      status: (await characterSheetHashMatchesStored(stored, payload))
        ? 'fresh'
        : 'stale',
      applicable: true,
    };
  }

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
