import type { ScopedDb } from '@/platform/server/db/scoped';
import { productionAccess } from '@/sequences/server/production-access';
import { loadSequenceSegments } from '@/shots/server/sequence-segments';

/** Explicit (potentially expensive) detail inspection, separate from cheap status polls. */
export async function readSegmentStaleness(
  scopedDb: ScopedDb,
  sequenceId: string,
  segmentId: string
) {
  const access = productionAccess(scopedDb);
  const sequence = await access.sequence(sequenceId);
  const segment = await access.segment(sequenceId, segmentId);
  const selected = segment.selectedVideoVersionId
    ? await scopedDb.videoVariants.getById(segment.selectedVideoVersionId)
    : null;
  if (
    selected?.renderSegmentId !== segment.id ||
    selected.discardedAt ||
    !selected.manifest.length
  )
    return { status: 'untracked' as const };
  // The editor's own assembly over every shot in the sequence, so this verdict
  // and the Scenes editor badge are one derivation.
  const { assembled } = await loadSequenceSegments(
    scopedDb,
    sequence,
    await scopedDb.shots.listBySequence(sequenceId)
  );
  const current = assembled.find((s) => s.id === segmentId);
  if (!current)
    throw new Error(`Render segment ${segmentId} was not assembled`);
  return { status: current.stale ? ('stale' as const) : ('fresh' as const) };
}
