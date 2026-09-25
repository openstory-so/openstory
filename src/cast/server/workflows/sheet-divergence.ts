/**
 * Reporting a parked sheet (#1113).
 *
 * A sheet run whose claim was revoked mid-flight (an input edit, a newer
 * kickoff, the user picking a sheet) parks its result as a divergent variant
 * instead of landing it. Character and sequence-location sheets park inside
 * their land batch (`src/cast/server/db/sheet-claims.ts`), so the helpers
 * for them only notify the UI via `stale:detected`. Library location and
 * talent results live outside the versions table, so their helpers still
 * insert the divergent row, then notify.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  CharacterSheetInputHash,
  LibraryLocationReferenceInputHash,
  LocationSheetInputHash,
  TalentSheetInputHash,
} from '@/shots/input-hash';
// `ScopedDb` is imported for type extraction only; the helpers themselves
// take a narrower `SheetDivergenceScopedDb` shape (defined below).
import {
  getGenerationChannel,
  getLocationChannel,
  getTalentChannel,
} from '@/platform/realtime';

// Subset of ScopedDb used by the helpers below. Defined structurally so the
// full ScopedDb is assignable (production passes it directly) and tests can
// build a minimal mock without `as any`. The return type is narrowed to
// `{ id: string }` because that's all these helpers consume from the row.
type LocInsertArgs = Parameters<
  ScopedDb['locationSheetVariants']['insertDivergent']
>[0];
type TalInsertArgs = Parameters<
  ScopedDb['talentSheetVariants']['insertDivergent']
>[0];
export type SheetDivergenceScopedDb = {
  locationSheetVariants: {
    insertDivergent: (values: LocInsertArgs) => Promise<{ id: string }>;
  };
  talentSheetVariants: {
    insertDivergent: (values: TalInsertArgs) => Promise<{ id: string }>;
  };
};

/** A character sheet run parked its result: tell the sequence's UI. */
export async function reportParkedCharacterSheet(args: {
  sequenceId: string;
  characterId: string;
  versionId: string;
  snapshotInputHash: CharacterSheetInputHash | undefined;
}): Promise<void> {
  await getGenerationChannel(args.sequenceId).emit(
    'generation.stale:detected',
    {
      entityType: 'character',
      entityId: args.characterId,
      artifact: 'sheet',
      snapshotInputHash: args.snapshotInputHash ?? '',
      divergedVariantId: args.versionId,
    }
  );
}

/** A sequence location sheet run parked its result: tell the sequence's UI. */
export async function reportParkedLocationSheet(args: {
  sequenceId: string;
  locationId: string;
  versionId: string;
  snapshotInputHash: LocationSheetInputHash | undefined;
}): Promise<void> {
  await getGenerationChannel(args.sequenceId).emit(
    'generation.stale:detected',
    {
      entityType: 'location',
      entityId: args.locationId,
      artifact: 'sheet',
      snapshotInputHash: args.snapshotInputHash ?? '',
      divergedVariantId: args.versionId,
    }
  );
}

export type SaveDivergentLibraryLocationSheetArgs = {
  scopedDb: SheetDivergenceScopedDb;
  libraryLocationId: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: LibraryLocationReferenceInputHash;
};

/** Park a library location run's preview and notify the location's UI. */
export async function saveDivergentLibraryLocationSheet({
  scopedDb,
  libraryLocationId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentLibraryLocationSheetArgs): Promise<string> {
  const variant = await scopedDb.locationSheetVariants.insertDivergent({
    parentType: 'library_location',
    parentId: libraryLocationId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await getLocationChannel(libraryLocationId).emit(
    'generation.stale:detected',
    {
      entityType: 'library-location',
      entityId: libraryLocationId,
      artifact: 'sheet',
      snapshotInputHash,
      divergedVariantId: variant.id,
    }
  );
  return variant.id;
}

export type SaveDivergentTalentSheetArgs = {
  scopedDb: SheetDivergenceScopedDb;
  talentSheetId: string;
  /**
   * Parent talent id — used for realtime channel routing. Required: the
   * talent channel is the only place the talent UI subscribes for stale
   * events. Passing nothing here would silently drop the notification.
   */
  talentId: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: TalentSheetInputHash;
};

export async function saveDivergentTalentSheet({
  scopedDb,
  talentSheetId,
  talentId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentTalentSheetArgs): Promise<string> {
  const variant = await scopedDb.talentSheetVariants.insertDivergent({
    talentSheetId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await getTalentChannel(talentId).emit('generation.stale:detected', {
    entityType: 'talent',
    entityId: talentSheetId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}
