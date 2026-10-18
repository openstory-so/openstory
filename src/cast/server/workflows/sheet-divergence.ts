/**
 * Reporting a parked sheet (#1113).
 *
 * A sheet run whose claim was revoked mid-flight (an input edit, a newer
 * kickoff, the user picking a sheet) parks its result as a divergent variant
 * instead of landing it. Character and sequence-location sheets park inside
 * their land batch (`src/cast/server/db/sheet-claims.ts`), so the helpers
 * for them only notify the UI via `stale:detected`.
 */

import type { SheetLanding } from '@/cast/server/db/sheet-claims';
import type { getLogger } from '@/platform/logger';
import type {
  CharacterSheetInputHash,
  LocationSheetInputHash,
} from '@/shots/input-hash';
import { getGenerationChannel } from '@/platform/realtime';

/** A sheet run parked its result: tell the UI that started it. */
export async function reportParkedSheet(args: {
  /**
   * The sequence's channel, or the character's or location's own
   * (`castChannelId`, `locationChannelId`).
   */
  channelId: string;
  entityType: 'character' | 'location';
  entityId: string;
  versionId: string;
  snapshotInputHash: CharacterSheetInputHash | LocationSheetInputHash;
}): Promise<void> {
  await getGenerationChannel(args.channelId).emit('generation.stale:detected', {
    entityType: args.entityType,
    entityId: args.entityId,
    artifact: 'sheet',
    snapshotInputHash: args.snapshotInputHash,
    divergedVariantId: args.versionId,
  });
}

export type SheetRunOutcome =
  | { kind: 'convergent'; versionId: string }
  | { kind: 'divergent'; versionId: string };

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
  return { kind: 'divergent', versionId: report.versionId };
}
