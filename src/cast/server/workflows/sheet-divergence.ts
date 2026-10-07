/**
 * Reporting a parked sheet (#1113).
 *
 * A sheet run whose claim was revoked mid-flight (an input edit, a newer
 * kickoff, the user picking a sheet) parks its result as a divergent variant
 * instead of landing it. Character and sequence-location sheets park inside
 * their land batch (`src/cast/server/db/sheet-claims.ts`), and a talent
 * sheet parks inside `talent.landSheet` (#2018), so the helpers for them only
 * notify the UI via `stale:detected`. Library location results live outside
 * the versions table, so that helper still inserts the divergent row, then
 * notifies.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { SheetLanding } from '@/cast/server/db/sheet-claims';
import type { getLogger } from '@/platform/logger';
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
export type SheetDivergenceScopedDb = {
  locationSheetVariants: {
    insertDivergent: (values: LocInsertArgs) => Promise<{ id: string }>;
  };
};

/** A sequence sheet run parked its result: tell the sequence's UI. */
export async function reportParkedSheet(args: {
  sequenceId: string;
  entityType: 'character' | 'location';
  entityId: string;
  versionId: string;
  snapshotInputHash: CharacterSheetInputHash | LocationSheetInputHash;
}): Promise<void> {
  await getGenerationChannel(args.sequenceId).emit(
    'generation.stale:detected',
    {
      entityType: args.entityType,
      entityId: args.entityId,
      artifact: 'sheet',
      snapshotInputHash: args.snapshotInputHash,
      divergedVariantId: args.versionId,
    }
  );
}

export type SheetRunOutcome =
  | { kind: 'convergent'; versionId: string }
  | { kind: 'divergent' };

/**
 * Land a sequence sheet run through the claim its trigger took (#1113):
 * `land` promotes only while the claim still names `versionId`, else parks it;
 * a park is logged and reported to the sequence's UI.
 */
export async function landSheetRun(
  args: Parameters<typeof reportParkedSheet>[0] & {
    land: () => Promise<SheetLanding>;
    logger: ReturnType<typeof getLogger>;
    logTag: string;
    claimed: boolean;
    storagePath: string;
  }
): Promise<SheetRunOutcome> {
  const { land, logger, logTag, claimed, storagePath, ...report } = args;
  if ((await land()) === 'promoted') {
    return { kind: 'convergent', versionId: report.versionId };
  }
  logger.warn(`${logTag} claim moved; sheet parked`, {
    entityId: report.entityId,
    versionId: report.versionId,
    claimed,
    storagePath,
  });
  await reportParkedSheet(report);
  return { kind: 'divergent' };
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

/**
 * A library talent run parked its sheet (`talent.landSheet` left the row
 * with `divergedAt` set, #2018): tell the talent's UI. `entityId` is the
 * talent (the only channel the talent UI subscribes to); the parked row is
 * `divergedVariantId`.
 */
export async function reportParkedTalentSheet(args: {
  talentId: string;
  sheetId: string;
  snapshotInputHash: TalentSheetInputHash;
}): Promise<void> {
  await getTalentChannel(args.talentId).emit('generation.stale:detected', {
    entityType: 'talent',
    entityId: args.talentId,
    artifact: 'sheet',
    snapshotInputHash: args.snapshotInputHash,
    divergedVariantId: args.sheetId,
  });
}
