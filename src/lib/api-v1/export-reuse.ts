/**
 * How POST /api/v1/sequences/$id/exports should treat rows that already
 * exist for this sequence (#1402, #1253).
 *
 * Theatre lookup is content-addressed on `sourceShotsHash`. The route must
 * do the same: a ready MP4 of the current cut is returned as-is rather than
 * spawning another container render. In-flight coalescing is one processing
 * row per sequence (the unique index), not per hash — a POST for a new cut
 * while another is rendering joins that row rather than starting a second.
 */

export type ExistingExportRow = {
  status: 'processing' | 'ready' | 'failed';
  sourceShotsHash: string | null;
  createdAt: Date;
};

export type ExistingExportDecision<T extends ExistingExportRow> =
  | { action: 'return-ready'; row: T }
  | { action: 'return-processing'; row: T }
  | { action: 'fail-stale-processing'; row: T }
  | { action: 'create' };

/**
 * `rows` is newest-first (listAllBySequence). Ready-hash wins over an
 * unrelated in-flight render so a second click for a cut that already
 * exported just serves the file.
 */
export function decideExistingExport<T extends ExistingExportRow>(
  rows: readonly T[],
  sourceShotsHash: string,
  nowMs: number,
  staleProcessingMs: number
): ExistingExportDecision<T> {
  const ready = rows.find(
    (row) => row.status === 'ready' && row.sourceShotsHash === sourceShotsHash
  );
  if (ready) return { action: 'return-ready', row: ready };

  const inFlight = rows.find((row) => row.status === 'processing');
  if (!inFlight) return { action: 'create' };
  if (nowMs - inFlight.createdAt.getTime() < staleProcessingMs) {
    return { action: 'return-processing', row: inFlight };
  }
  return { action: 'fail-stale-processing', row: inFlight };
}
