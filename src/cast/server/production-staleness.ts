import type { ScopedDb } from '@/platform/server/db/scoped';
import { productionAccess } from '@/sequences/server/production-access';
import { buildRegenerateCharacterSheetPayload } from './sheets/character-sheet-trigger';
import { buildRegenerateLocationSheetPayload } from './sheets/location-sheet-trigger';
import {
  characterSheetHashMatchesStored,
  locationSheetHashMatchesStored,
} from './workflows/sheet-snapshots';

/** Compute with the same payload/hash functions as the editor, without dispatching work. */
export async function readReferenceStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  kind: 'character' | 'location',
  entityId: string
) {
  const access = productionAccess(scopedDb);
  const context = {
    scopedDb,
    sequence: await access.sequence(sequenceId),
    userId: scopedDb.userId,
    teamId: scopedDb.teamId,
  };
  if (kind === 'character') {
    const character = await access.character(sequenceId, entityId);
    if (character.voiceOnly)
      return { status: 'untracked' as const, applicable: false };
    if (character.sheetStatus === 'generating')
      return { status: 'generating' as const, applicable: true };
    if (!character.sheetInputHash)
      return { status: 'untracked' as const, applicable: true };
    const payload = await buildRegenerateCharacterSheetPayload({
      ...context,
      character,
    });
    return {
      status: (await characterSheetHashMatchesStored(
        character.sheetInputHash,
        payload
      ))
        ? ('fresh' as const)
        : ('stale' as const),
      applicable: true,
    };
  }
  const location = await access.location(sequenceId, entityId);
  if (location.referenceStatus === 'generating')
    return { status: 'generating' as const, applicable: true };
  if (!location.referenceInputHash)
    return { status: 'untracked' as const, applicable: true };
  const payload = await buildRegenerateLocationSheetPayload({
    ...context,
    location,
  });
  return {
    status: (await locationSheetHashMatchesStored(
      location.referenceInputHash,
      payload
    ))
      ? ('fresh' as const)
      : ('stale' as const),
    applicable: true,
  };
}
