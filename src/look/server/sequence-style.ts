import { resolveSequenceStyleConfig } from '@/look/style-config';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError } from '@/platform/errors';

/** Freeze the sequence look before queuing work, including legacy unsnapshotted rows. */
export async function loadSequenceStyle(
  scopedDb: Pick<ScopedDb, 'sequences' | 'styles'>,
  sequence: { id: string; styleConfig?: unknown; styleId?: string | null }
) {
  const source =
    sequence.styleConfig === undefined
      ? await scopedDb.sequences.getById(sequence.id)
      : sequence;
  if (!source) throw new NotFoundError('Sequence not found');
  const live =
    source.styleConfig == null && source.styleId
      ? await scopedDb.styles.getById(source.styleId)
      : null;
  return resolveSequenceStyleConfig({
    snapshot: source.styleConfig,
    live: live?.config,
  });
}
